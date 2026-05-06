#!/usr/bin/env python3
"""
Indeed Semi-Auto Apply
----------------------
Opens an Indeed job URL, clicks Apply, fills the form with profile data + tailored
resume (downloaded from a URL), then PAUSES BEFORE submit. Prints submit-page URL
and screenshot path on stdout (last line: JSON).

Design:
  - NO auto-submit. Human must click submit manually.
  - NO undetected-chromedriver / stealth. Vanilla Playwright.
  - Reuses indeed_session.json if present (cookies). Run with --login once to seed.
  - Output is single JSON object on the last stdout line for server.mjs to parse.

Usage:
  python3 indeed_semi_auto.py --login
  python3 indeed_semi_auto.py --job-url <URL> --resume-url <URL> [--cover-letter "..."] [--role "..."] [--company "..."]

Status values:
  awaiting_submit  - form filled, browser left open, user must click submit
  not_indeed_apply - "Apply on company site" external redirect
  no_apply_button  - couldn't find apply button
  failed           - error occurred
"""
import argparse
import json
import os
import re
import sys
import tempfile
import urllib.request
from datetime import datetime
from pathlib import Path

import yaml
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

RESUME_YAML = Path(os.environ.get('RESUME_YAML', ''))
SESSION_FILE = Path(os.environ.get('INDEED_SESSION',
    str(Path(__file__).parent / 'indeed_session.json')))
LOG_DIR = Path(os.environ.get('LOG_DIR', '/tmp/indeed_apply_logs'))
LOG_DIR.mkdir(parents=True, exist_ok=True)


def load_personal():
    if not RESUME_YAML.exists():
        return {}
    with open(RESUME_YAML) as f:
        data = yaml.safe_load(f) or {}
    return data.get('personal_information', {}) or {}


def download_resume(url):
    """Download resume PDF to /tmp, return local path."""
    fd, path = tempfile.mkstemp(suffix='.pdf', prefix='tailored-resume-')
    os.close(fd)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        with open(path, 'wb') as f:
            f.write(r.read())
    return path


def match_field(label, personal):
    label = label.lower()
    if any(k in label for k in ['first name', 'given name']):
        return personal.get('name', '')
    if any(k in label for k in ['last name', 'surname', 'family name']):
        return personal.get('surname', '')
    if 'full name' in label:
        return f"{personal.get('name', '')} {personal.get('surname', '')}".strip()
    if 'email' in label:
        return personal.get('email', '')
    if 'phone' in label or 'mobile' in label:
        prefix = personal.get('phone_prefix', '')
        return f"{prefix}{personal.get('phone', '')}"
    if 'city' in label or 'location' in label:
        return personal.get('city', '')
    if 'linkedin' in label:
        return personal.get('linkedin', '')
    if 'github' in label:
        return personal.get('github', '')
    if 'years' in label and ('experience' in label or 'exp' in label):
        return str(personal.get('years_of_experience', '16'))
    if 'notice' in label:
        return '30'
    return None


def fill_form(page, personal, cover_letter, resume_path, log):
    """Best-effort fill of Indeed apply form fields. No submit."""
    page.wait_for_timeout(2000)

    # Multi-step Indeed apply form — loop through Continue/Review steps.
    for step in range(8):
        page.wait_for_timeout(1500)

        # Text inputs
        inputs = page.query_selector_all('input[type="text"], input[type="email"], input[type="tel"], input[type="number"]')
        for inp in inputs:
            try:
                if not inp.is_visible():
                    continue
                if inp.input_value():
                    continue
                aria = (inp.get_attribute('aria-label') or '').strip()
                placeholder = (inp.get_attribute('placeholder') or '').strip()
                name_attr = (inp.get_attribute('name') or '').strip()
                # Try associated label
                label_text = ''
                input_id = inp.get_attribute('id')
                if input_id:
                    lab = page.query_selector(f'label[for="{input_id}"]')
                    if lab:
                        label_text = lab.inner_text()
                combined = ' '.join([aria, placeholder, name_attr, label_text])
                val = match_field(combined, personal)
                if val:
                    inp.fill(val)
                    log.append(f'filled "{combined.strip()[:40]}" = "{val[:40]}"')
            except Exception as e:
                log.append(f'input err: {e}')

        # Resume upload
        file_inputs = page.query_selector_all('input[type="file"]')
        for fi in file_inputs:
            try:
                if resume_path and Path(resume_path).exists():
                    fi.set_input_files(resume_path)
                    log.append(f'uploaded resume {resume_path}')
            except Exception as e:
                log.append(f'upload err: {e}')

        # Cover letter
        if cover_letter:
            for ta in page.query_selector_all('textarea'):
                try:
                    if not ta.is_visible() or ta.input_value():
                        continue
                    ta.fill(cover_letter[:3000])
                    log.append('filled cover letter textarea')
                    break
                except Exception:
                    pass

        # Selects — pick first non-empty option
        for sel in page.query_selector_all('select'):
            try:
                if not sel.is_visible():
                    continue
                opts = sel.query_selector_all('option')
                if len(opts) > 1:
                    for opt in opts[1:]:
                        v = opt.get_attribute('value')
                        if v:
                            sel.select_option(value=v)
                            break
            except Exception:
                pass

        # Look for STOP markers — a Submit button means we are at the final step.
        submit_btn = page.query_selector(
            'button:has-text("Submit application"), button:has-text("Submit your application"), '
            'button[type="submit"]:has-text("Submit"), button:has-text("Submit")'
        )
        if submit_btn and submit_btn.is_visible():
            log.append('SUBMIT button detected — pausing here')
            return True

        # Click Continue / Next / Review
        next_btn = page.query_selector(
            'button:has-text("Continue"), button:has-text("Next"), button:has-text("Review your application")'
        )
        if next_btn and next_btn.is_visible():
            try:
                next_btn.click()
                log.append('clicked Continue/Next/Review')
            except Exception as e:
                log.append(f'next click err: {e}')
                break
        else:
            log.append('no Continue button — exiting fill loop')
            break

    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--job-url', required=False)
    ap.add_argument('--resume-url', required=False, default='')
    ap.add_argument('--cover-letter', default='')
    ap.add_argument('--role', default='')
    ap.add_argument('--company', default='')
    ap.add_argument('--login', action='store_true', help='Seed indeed_session.json (manual login)')
    ap.add_argument('--keep-open', action='store_true', help='Leave browser open after fill (for manual submit)')
    ap.add_argument('--headless', action='store_true', help='Run headless (form fill only — no manual submit)')
    args = ap.parse_args()

    log = []
    out = {
        'job_url': args.job_url, 'role': args.role, 'company': args.company,
        'submit_url': None, 'screenshot': None, 'status': 'failed', 'log': '',
        'timestamp': datetime.now().isoformat(),
    }

    personal = load_personal()
    resume_path = None
    if args.resume_url:
        try:
            resume_path = download_resume(args.resume_url)
            log.append(f'resume downloaded: {resume_path}')
        except Exception as e:
            log.append(f'resume download FAILED: {e}')

    headless = bool(args.headless)
    keep_open = bool(args.keep_open) and not headless

    with sync_playwright() as pw:
        # storage_state for session reuse
        ctx_kwargs = {
            'viewport': {'width': 1366, 'height': 900},
            'user_agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
        if SESSION_FILE.exists():
            ctx_kwargs['storage_state'] = str(SESSION_FILE)
            log.append('loaded saved Indeed session')

        browser = pw.chromium.launch(headless=headless, args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(**ctx_kwargs)
        page = context.new_page()

        try:
            if args.login:
                # Manual login mode: open Indeed login, wait, persist cookies.
                page.goto('https://secure.indeed.com/auth', wait_until='domcontentloaded', timeout=30000)
                login_wait = int(os.environ.get('LOGIN_WAIT_MS', '600000'))
                print(f'[manual] log in via the browser window. Closing in {login_wait/1000:.0f}s.', file=sys.stderr)
                page.wait_for_timeout(login_wait)
                context.storage_state(path=str(SESSION_FILE))
                out['status'] = 'session_saved'
                out['log'] = 'session saved to ' + str(SESSION_FILE)
                print(json.dumps(out))
                return

            if not args.job_url:
                out['log'] = 'job-url required'
                print(json.dumps(out))
                sys.exit(1)

            # Navigate to job
            page.goto(args.job_url, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(2500)
            log.append(f'opened {args.job_url}')

            # Click Apply
            apply_btn = page.query_selector(
                'button:has-text("Apply now"), button[id*="indeedApply"], '
                'a:has-text("Apply now"), button:has-text("Apply on company site")'
            )
            if not apply_btn:
                # Indeed often has "Apply now" inside an iframe — try alternative selectors.
                apply_btn = page.query_selector('button:has-text("Apply"), a:has-text("Apply")')

            if not apply_btn:
                out['status'] = 'no_apply_button'
                out['submit_url'] = page.url
                log.append('no apply button found (likely not logged in or job expired)')
                # Screenshot landing page anyway for debug
                shot = LOG_DIR / f'indeed-noapply-{datetime.now().strftime("%Y%m%d-%H%M%S")}.png'
                try:
                    page.screenshot(path=str(shot), full_page=True)
                    out['screenshot'] = str(shot)
                    log.append(f'screenshot: {shot}')
                except Exception:
                    pass
                raise RuntimeError('No apply button — run --login first to seed indeed_session.json')

            btn_text = (apply_btn.inner_text() or '').lower()
            if 'company site' in btn_text:
                out['status'] = 'not_indeed_apply'
                log.append(f'external apply: "{btn_text}"')
                # Click anyway and capture redirected URL
                try:
                    with context.expect_page(timeout=10000) as new_page_info:
                        apply_btn.click()
                    new_page = new_page_info.value
                    new_page.wait_for_load_state('domcontentloaded', timeout=15000)
                    out['submit_url'] = new_page.url
                except PWTimeout:
                    apply_btn.click()
                    page.wait_for_timeout(3000)
                    out['submit_url'] = page.url
            else:
                apply_btn.click()
                page.wait_for_timeout(3500)
                # If apply opened a new tab/page (Indeed Apply iframe sometimes behaves that way)
                if len(context.pages) > 1:
                    page = context.pages[-1]
                    page.wait_for_load_state('domcontentloaded', timeout=15000)

                ready = fill_form(page, personal, args.cover_letter, resume_path, log)
                out['submit_url'] = page.url
                out['status'] = 'awaiting_submit' if ready else 'form_partial'

            # Screenshot of submit-stage page
            shot = LOG_DIR / f'indeed-{datetime.now().strftime("%Y%m%d-%H%M%S")}.png'
            try:
                page.screenshot(path=str(shot), full_page=True)
                out['screenshot'] = str(shot)
                log.append(f'screenshot: {shot}')
            except Exception as e:
                log.append(f'screenshot err: {e}')

            # Persist session for next run
            try:
                context.storage_state(path=str(SESSION_FILE))
            except Exception:
                pass

            if keep_open:
                print('[paused] browser open — close window after manual submit. 5 min timeout.', file=sys.stderr)
                page.wait_for_timeout(300000)

        except Exception as e:
            out['log'] = str(e)
            log.append(f'EXC: {e}')
        finally:
            out['log'] = '\n'.join(log)
            if not keep_open:
                try:
                    browser.close()
                except Exception:
                    pass

    print(json.dumps(out))


if __name__ == '__main__':
    main()
