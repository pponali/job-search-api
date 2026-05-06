#!/usr/bin/env python3
"""
Auto-Apply Bot — LinkedIn Easy Apply (Primary) + Playwright Fallback (Secondary)

Uses Selenium for LinkedIn Easy Apply jobs.
Falls back to Playwright for non-Easy-Apply jobs on LinkedIn/Indeed/Naukri.
"""

import json
import os
import sys
import time
import yaml
import logging
import argparse
import traceback
from pathlib import Path
from datetime import datetime

# Setup logging
LOG_FILE = os.environ.get('AUTO_APPLY_LOG', str(Path(__file__).parent / 'auto_apply.log'))
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('auto_apply')

# Paths
AIHAWK_DIR = Path(os.environ.get('AIHAWK_DIR', ''))
if not str(AIHAWK_DIR) or not AIHAWK_DIR.exists():
    logger.warning('AIHAWK_DIR env var not set or path missing — resume/secrets loading will fail.')
DATA_DIR = AIHAWK_DIR / 'data_folder'
RESUME_YAML = DATA_DIR / 'plain_text_resume.yaml'
SECRETS_YAML = DATA_DIR / 'secrets.yaml'
RESUME_PDF = AIHAWK_DIR / 'resume_base.pdf'

# Load resume data
def load_resume():
    with open(RESUME_YAML) as f:
        return yaml.safe_load(f)

def load_secrets():
    with open(SECRETS_YAML) as f:
        return yaml.safe_load(f)


# ============================================================
# OPTION A: LinkedIn Easy Apply via Selenium
# ============================================================

class LinkedInEasyApply:
    """Handles LinkedIn Easy Apply using Selenium + undetected-chromedriver."""

    def __init__(self, email=None, password=None, headless=True):
        self.email = email
        self.password = password
        self.headless = headless
        self.driver = None
        self.resume_data = load_resume()
        self.personal = self.resume_data.get('personal_information', {})
        self.applied_urls = set()

    def init_browser(self):
        """Initialize Chrome browser with stealth settings."""
        try:
            import undetected_chromedriver as uc
            options = uc.ChromeOptions()
            if self.headless:
                options.add_argument('--headless=new')
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--disable-blink-features=AutomationControlled')
            options.add_argument('--window-size=1920,1080')
            options.add_argument('--lang=en-US')
            self.driver = uc.Chrome(options=options)
            self.driver.implicitly_wait(10)
            logger.info("Chrome browser initialized (Selenium/undetected-chromedriver)")
            return True
        except Exception as e:
            logger.error(f"Failed to init Chrome: {e}")
            return False

    def login(self):
        """Login to LinkedIn."""
        if not self.email or not self.password:
            logger.error("LinkedIn credentials not provided")
            return False

        try:
            self.driver.get('https://www.linkedin.com/login')
            time.sleep(2)

            # Enter email
            email_field = self.driver.find_element('id', 'username')
            email_field.clear()
            email_field.send_keys(self.email)

            # Enter password
            password_field = self.driver.find_element('id', 'password')
            password_field.clear()
            password_field.send_keys(self.password)

            # Click login
            login_btn = self.driver.find_element('css selector', 'button[type="submit"]')
            login_btn.click()
            time.sleep(3)

            # Check for CAPTCHA or verification
            page_source = self.driver.page_source.lower()
            if 'checkpoint' in page_source or 'captcha' in page_source or 'verification' in page_source:
                logger.warning("CAPTCHA or verification detected — manual intervention needed")
                return False

            if 'feed' in self.driver.current_url or 'mynetwork' in self.driver.current_url:
                logger.info("LinkedIn login successful")
                return True

            logger.warning(f"Unexpected page after login: {self.driver.current_url}")
            return False

        except Exception as e:
            logger.error(f"Login failed: {e}")
            return False

    def apply_to_job(self, job_url, cover_letter=None):
        """Apply to a LinkedIn Easy Apply job."""
        result = {
            'url': job_url,
            'status': 'failed',
            'method': 'linkedin_easy_apply',
            'error': None,
            'timestamp': datetime.now().isoformat()
        }

        try:
            self.driver.get(job_url)
            time.sleep(3)

            # Check if Easy Apply button exists
            easy_apply_btns = self.driver.find_elements('css selector',
                'button.jobs-apply-button, button[aria-label*="Easy Apply"]')

            if not easy_apply_btns:
                result['status'] = 'not_easy_apply'
                result['error'] = 'No Easy Apply button found'
                logger.info(f"Not Easy Apply: {job_url}")
                return result

            # Click Easy Apply
            easy_apply_btns[0].click()
            time.sleep(2)

            # Fill form fields
            applied = self._fill_and_submit_form(cover_letter)

            if applied:
                result['status'] = 'applied'
                self.applied_urls.add(job_url)
                logger.info(f"Successfully applied: {job_url}")
            else:
                result['status'] = 'form_incomplete'
                result['error'] = 'Could not complete all form fields'

        except Exception as e:
            result['error'] = str(e)
            logger.error(f"Apply error for {job_url}: {e}")

        return result

    def _fill_and_submit_form(self, cover_letter=None):
        """Fill Easy Apply multi-step form and submit."""
        max_steps = 10
        for step in range(max_steps):
            time.sleep(1)

            # Fill any text inputs
            self._fill_text_fields()

            # Upload resume if prompted
            self._upload_resume()

            # Fill cover letter if field exists
            if cover_letter:
                self._fill_cover_letter(cover_letter)

            # Handle radio buttons / dropdowns
            self._handle_selects()

            # Check for Submit button
            submit_btns = self.driver.find_elements('css selector',
                'button[aria-label*="Submit"], button[aria-label*="submit"]')
            if submit_btns:
                submit_btns[0].click()
                time.sleep(2)
                # Check for confirmation
                page_source = self.driver.page_source.lower()
                if 'application sent' in page_source or 'applied' in page_source:
                    return True

            # Click Next/Continue/Review
            next_btns = self.driver.find_elements('css selector',
                'button[aria-label*="Next"], button[aria-label*="Continue"], '
                'button[aria-label*="Review"]')
            if next_btns:
                next_btns[0].click()
                continue

            # No more buttons — check if we're done
            break

        return False

    def _fill_text_fields(self):
        """Auto-fill text input fields based on label matching."""
        from selenium.webdriver.common.by import By

        inputs = self.driver.find_elements(By.CSS_SELECTOR, 'input[type="text"], input[type="tel"], input[type="email"], input[type="number"]')
        for inp in inputs:
            if inp.get_attribute('value'):
                continue  # Already filled
            label = ''
            try:
                label_id = inp.get_attribute('id')
                if label_id:
                    labels = self.driver.find_elements(By.CSS_SELECTOR, f'label[for="{label_id}"]')
                    if labels:
                        label = labels[0].text.lower()
            except:
                pass

            aria_label = (inp.get_attribute('aria-label') or '').lower()
            placeholder = (inp.get_attribute('placeholder') or '').lower()
            combined = f"{label} {aria_label} {placeholder}"

            value = self._match_field(combined)
            if value:
                inp.clear()
                inp.send_keys(value)

    def _match_field(self, field_text):
        """Match form field labels to resume data."""
        p = self.personal
        field_text = field_text.lower()

        if any(k in field_text for k in ['first name', 'given name']):
            return p.get('name', '')
        if any(k in field_text for k in ['last name', 'surname', 'family name']):
            return p.get('surname', '')
        if 'email' in field_text:
            return p.get('email', '')
        if 'phone' in field_text or 'mobile' in field_text:
            return f"{p.get('phone_prefix', '')}{p.get('phone', '')}"
        if 'city' in field_text or 'location' in field_text:
            return p.get('city', 'Bangalore')
        if 'linkedin' in field_text:
            return p.get('linkedin', '')
        if 'github' in field_text:
            return p.get('github', '')
        if any(k in field_text for k in ['year', 'experience']):
            return '16'
        if 'salary' in field_text or 'ctc' in field_text or 'compensation' in field_text:
            return ''  # Don't auto-fill salary
        if 'notice' in field_text:
            return '30'

        return None

    def _upload_resume(self):
        """Upload resume PDF if file input is present."""
        from selenium.webdriver.common.by import By
        file_inputs = self.driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
        for fi in file_inputs:
            if RESUME_PDF.exists():
                try:
                    fi.send_keys(str(RESUME_PDF))
                    logger.info("Resume uploaded")
                except:
                    pass

    def _fill_cover_letter(self, cover_letter):
        """Fill cover letter textarea."""
        from selenium.webdriver.common.by import By
        textareas = self.driver.find_elements(By.CSS_SELECTOR, 'textarea')
        for ta in textareas:
            label = (ta.get_attribute('aria-label') or '').lower()
            if 'cover' in label or not ta.get_attribute('value'):
                ta.clear()
                ta.send_keys(cover_letter[:3000])
                break

    def _handle_selects(self):
        """Handle dropdown selects with best-guess answers."""
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import Select

        selects = self.driver.find_elements(By.CSS_SELECTOR, 'select')
        for sel_elem in selects:
            try:
                sel = Select(sel_elem)
                if sel.first_selected_option.text.strip():
                    continue  # Already selected
                # Select second option (first is usually placeholder)
                if len(sel.options) > 1:
                    sel.select_by_index(1)
            except:
                pass

    def close(self):
        if self.driver:
            self.driver.quit()


# ============================================================
# OPTION B: Playwright Fallback for Non-Easy-Apply Jobs
# ============================================================

class PlaywrightApply:
    """Auto-apply using Playwright for LinkedIn Easy Apply + Indeed/Naukri."""

    def __init__(self, headless=True, linkedin_email=None, linkedin_password=None):
        self.headless = headless
        self.linkedin_email = linkedin_email
        self.linkedin_password = linkedin_password
        self.browser = None
        self.page = None
        self.resume_data = load_resume()
        self.personal = self.resume_data.get('personal_information', {})
        self.logged_in = False

    def init_browser(self):
        """Initialize Playwright browser."""
        try:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
            self.browser = self.pw.chromium.launch(
                headless=self.headless,
                args=['--no-sandbox', '--disable-dev-shm-usage']
            )
            self.context = self.browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            self.page = self.context.new_page()
            logger.info("Playwright browser initialized")
            return True
        except Exception as e:
            logger.error(f"Failed to init Playwright: {e}")
            return False

    def login_linkedin(self):
        """Login to LinkedIn via cookie injection (bypasses CAPTCHA)."""
        # Try cookie-based login first
        cookie_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.linkedin_cookie')
        li_at = os.environ.get('LINKEDIN_LI_AT', '')

        if not li_at and os.path.exists(cookie_file):
            with open(cookie_file) as f:
                li_at = f.read().strip()

        if li_at:
            logger.info("Using li_at cookie for LinkedIn login")
            self.context.add_cookies([
                {
                    'name': 'li_at',
                    'value': li_at,
                    'domain': '.linkedin.com',
                    'path': '/',
                    'httpOnly': True,
                    'secure': True,
                    'sameSite': 'None'
                }
            ])
            # Verify the cookie works
            self.page.goto('https://www.linkedin.com/feed/', wait_until='domcontentloaded', timeout=30000)
            self.page.wait_for_timeout(3000)
            url = self.page.url
            if 'login' not in url and 'checkpoint' not in url:
                logger.info("LinkedIn cookie login successful")
                self.logged_in = True
                return True
            else:
                logger.warning(f"Cookie login failed, redirected to: {url}")

        # Fallback to credential-based login
        if not self.linkedin_email or not self.linkedin_password:
            logger.warning("No LinkedIn credentials for Playwright login")
            return False
        try:
            self.page.goto('https://www.linkedin.com/login', wait_until='domcontentloaded', timeout=30000)
            self.page.wait_for_timeout(2000)
            self.page.fill('#username', self.linkedin_email)
            self.page.fill('#password', self.linkedin_password)
            self.page.click('button[type="submit"]')
            self.page.wait_for_timeout(5000)

            url = self.page.url
            if 'checkpoint' in url or 'challenge' in url:
                logger.warning("LinkedIn CAPTCHA/verification detected — manual intervention needed")
                return False

            if 'feed' in url or 'mynetwork' in url or 'jobs' in url:
                logger.info("LinkedIn login successful (Playwright)")
                self.logged_in = True
                return True

            logger.warning(f"Unexpected post-login URL: {url}")
            return False
        except Exception as e:
            logger.error(f"LinkedIn Playwright login failed: {e}")
            return False

    def apply_to_job(self, job_url, site='linkedin', cover_letter=None):
        """Apply to a job using Playwright."""
        result = {
            'url': job_url,
            'status': 'failed',
            'method': 'playwright_fallback',
            'error': None,
            'timestamp': datetime.now().isoformat()
        }

        try:
            self.page.goto(job_url, wait_until='domcontentloaded', timeout=30000)
            self.page.wait_for_timeout(3000)

            if 'linkedin.com' in job_url:
                result = self._apply_linkedin_external(job_url, cover_letter, result)
            elif 'indeed.com' in job_url:
                result = self._apply_indeed(job_url, cover_letter, result)
            elif 'naukri.com' in job_url:
                result = self._apply_naukri(job_url, cover_letter, result)
            else:
                result['error'] = f'Unsupported site for auto-apply'
                result['status'] = 'unsupported_site'

        except Exception as e:
            result['error'] = str(e)
            logger.error(f"Playwright apply error for {job_url}: {e}")

        return result

    def _apply_linkedin_external(self, job_url, cover_letter, result):
        """Handle LinkedIn jobs — Easy Apply if logged in, else external."""
        # Check for Easy Apply button first
        easy_apply_btn = self.page.query_selector(
            'button.jobs-apply-button:has-text("Easy Apply"), '
            'button[aria-label*="Easy Apply"]'
        )

        if easy_apply_btn and self.logged_in:
            logger.info("Found Easy Apply button — applying")
            easy_apply_btn.click()
            self.page.wait_for_timeout(2000)
            result = self._handle_easy_apply_modal(cover_letter, result)
            return result

        # Regular Apply button (redirects to company site)
        apply_btn = self.page.query_selector(
            'button.jobs-apply-button, a[href*="apply"], '
            'button:has-text("Apply"), a:has-text("Apply")'
        )
        if apply_btn:
            apply_btn.click()
            self.page.wait_for_timeout(3000)

            pages = self.context.pages
            if len(pages) > 1:
                new_page = pages[-1]
                new_page.wait_for_load_state('domcontentloaded')
                self._fill_generic_form(new_page, cover_letter)
                result['status'] = 'external_form_filled'
                result['error'] = 'External application — manual review recommended'
            else:
                result['status'] = 'redirect_failed'
                result['error'] = 'Apply button did not open external form'
        else:
            result['status'] = 'no_apply_button'
            result['error'] = 'No apply button found'

        return result

    def _handle_easy_apply_modal(self, cover_letter, result):
        """Handle the LinkedIn Easy Apply multi-step modal."""
        max_steps = 10
        for step in range(max_steps):
            self.page.wait_for_timeout(1500)

            # Fill visible input fields
            inputs = self.page.query_selector_all('input[type="text"]:visible, input[type="tel"]:visible, input[type="email"]:visible')
            for inp in inputs:
                label = inp.get_attribute('aria-label') or inp.get_attribute('placeholder') or ''
                label_lower = label.lower()
                val = inp.input_value()
                if val:
                    continue  # Already filled
                if 'phone' in label_lower or 'mobile' in label_lower:
                    inp.fill(self.personal.get('phone_prefix', '') + self.personal.get('phone', ''))
                elif 'email' in label_lower:
                    inp.fill(self.personal.get('email', ''))
                elif 'city' in label_lower or 'location' in label_lower:
                    inp.fill(self.personal.get('city', ''))
                elif 'year' in label_lower and 'experience' in label_lower:
                    inp.fill(str(self.personal.get('years_of_experience', '16')))

            # Fill textareas (cover letter, additional info)
            textareas = self.page.query_selector_all('textarea:visible')
            for ta in textareas:
                if not ta.input_value() and cover_letter:
                    ta.fill(cover_letter[:3000])

            # Handle dropdowns
            selects = self.page.query_selector_all('select:visible')
            for sel in selects:
                options = sel.query_selector_all('option')
                if len(options) > 1:
                    # Select first non-empty option
                    for opt in options[1:]:
                        val = opt.get_attribute('value')
                        if val:
                            sel.select_option(value=val)
                            break

            # Handle radio buttons — select first option
            radios = self.page.query_selector_all('input[type="radio"]:visible')
            seen_names = set()
            for radio in radios:
                name = radio.get_attribute('name') or ''
                if name not in seen_names:
                    radio.click()
                    seen_names.add(name)

            # Check for Submit button
            submit_btn = self.page.query_selector(
                'button[aria-label*="Submit"]:visible, '
                'button:has-text("Submit application"):visible, '
                'button:has-text("Submit"):visible'
            )
            if submit_btn:
                submit_btn.click()
                self.page.wait_for_timeout(3000)

                # Check for success
                success = self.page.query_selector(
                    'h2:has-text("applied"), div:has-text("Application sent"), '
                    'h2:has-text("Application submitted")'
                )
                if success:
                    result['status'] = 'applied'
                    result['method'] = 'linkedin_easy_apply_playwright'
                    logger.info("Easy Apply SUCCESS")
                else:
                    result['status'] = 'submitted_unconfirmed'
                    result['method'] = 'linkedin_easy_apply_playwright'
                    logger.info("Submit clicked but no confirmation detected")
                return result

            # Click Next/Continue/Review button
            next_btn = self.page.query_selector(
                'button[aria-label*="Continue"]:visible, '
                'button[aria-label*="Next"]:visible, '
                'button[aria-label*="Review"]:visible, '
                'button:has-text("Next"):visible, '
                'button:has-text("Continue"):visible, '
                'button:has-text("Review"):visible'
            )
            if next_btn:
                next_btn.click()
            else:
                break

        result['status'] = 'form_filled'
        result['method'] = 'linkedin_easy_apply_playwright'
        result['error'] = 'Reached max steps without submit'
        return result

    def _apply_indeed(self, job_url, cover_letter, result):
        """Handle Indeed job applications."""
        apply_btn = self.page.query_selector('button[id*="apply"], a[id*="apply"], button:has-text("Apply")')
        if apply_btn:
            apply_btn.click()
            self.page.wait_for_timeout(3000)
            self._fill_generic_form(self.page, cover_letter)
            result['status'] = 'form_filled'
            result['error'] = 'Indeed form filled — manual submit may be needed'
        else:
            result['status'] = 'no_apply_button'

        return result

    def _apply_naukri(self, job_url, cover_letter, result):
        """Handle Naukri.com job applications."""
        apply_btn = self.page.query_selector('button:has-text("Apply"), button[id*="apply"]')
        if apply_btn:
            apply_btn.click()
            self.page.wait_for_timeout(3000)
            self._fill_generic_form(self.page, cover_letter)
            result['status'] = 'form_filled'
        else:
            result['status'] = 'no_apply_button'

        return result

    def _fill_generic_form(self, page, cover_letter=None):
        """Best-effort form filling on any site."""
        p = self.personal

        # Fill text inputs by label/name/placeholder matching
        field_map = {
            'name': p.get('name', '') + ' ' + p.get('surname', ''),
            'first': p.get('name', ''),
            'last': p.get('surname', ''),
            'email': p.get('email', ''),
            'phone': p.get('phone', ''),
            'mobile': p.get('phone', ''),
            'city': p.get('city', 'Bangalore'),
            'location': p.get('city', 'Bangalore'),
        }

        inputs = page.query_selector_all('input[type="text"], input[type="email"], input[type="tel"]')
        for inp in inputs:
            name = (inp.get_attribute('name') or '').lower()
            placeholder = (inp.get_attribute('placeholder') or '').lower()
            aria = (inp.get_attribute('aria-label') or '').lower()
            combined = f"{name} {placeholder} {aria}"

            for key, value in field_map.items():
                if key in combined and value:
                    inp.fill(value)
                    break

        # Fill cover letter textarea
        if cover_letter:
            textareas = page.query_selector_all('textarea')
            for ta in textareas:
                ta.fill(cover_letter[:3000])
                break

        # Upload resume
        file_inputs = page.query_selector_all('input[type="file"]')
        for fi in file_inputs:
            if RESUME_PDF.exists():
                fi.set_input_files(str(RESUME_PDF))

    def close(self):
        if self.browser:
            self.browser.close()
        if hasattr(self, 'pw'):
            self.pw.stop()


# ============================================================
# ORCHESTRATOR — Combines Option A + Option B
# ============================================================

class AutoApplyOrchestrator:
    """
    Orchestrates auto-apply:
    1. Try LinkedIn Easy Apply (Option A) first
    2. Fall back to Playwright (Option B) if not Easy Apply
    """

    def __init__(self, linkedin_email=None, linkedin_password=None, headless=True):
        self.linkedin_email = linkedin_email
        self.linkedin_password = linkedin_password
        self.linkedin_bot = LinkedInEasyApply(linkedin_email, linkedin_password, headless)
        self.playwright_bot = PlaywrightApply(headless, linkedin_email, linkedin_password)
        self.results = []
        self.linkedin_initialized = False
        self.playwright_initialized = False

    def init(self):
        """Initialize browsers — Playwright is primary, Selenium is fallback."""
        # Try Selenium first (won't work on ARM)
        self.linkedin_initialized = self.linkedin_bot.init_browser()
        if self.linkedin_initialized and self.linkedin_bot.email:
            login_ok = self.linkedin_bot.login()
            if not login_ok:
                logger.warning("Selenium LinkedIn login failed")
                self.linkedin_initialized = False

        # Playwright — always init, login to LinkedIn if we have creds
        self.playwright_initialized = self.playwright_bot.init_browser()
        if self.playwright_initialized and self.linkedin_email:
            login_ok = self.playwright_bot.login_linkedin()
            if login_ok:
                logger.info("Playwright LinkedIn login successful — using as primary")
            else:
                logger.warning("Playwright LinkedIn login failed")

        return self.linkedin_initialized or self.playwright_initialized

    def apply_to_job(self, job_url, site='linkedin', cover_letter=None):
        """Apply to a single job using best available method."""
        result = None

        # Option A: Try LinkedIn Easy Apply first
        if 'linkedin.com' in job_url and self.linkedin_initialized:
            logger.info(f"[Option A] Trying LinkedIn Easy Apply: {job_url}")
            result = self.linkedin_bot.apply_to_job(job_url, cover_letter)

            if result['status'] == 'applied':
                self.results.append(result)
                return result

            # If not Easy Apply, fall through to Option B
            if result['status'] == 'not_easy_apply':
                logger.info(f"[Option B] Falling back to Playwright: {job_url}")

        # Option B: Playwright fallback
        if self.playwright_initialized:
            if result is None or result['status'] in ('not_easy_apply', 'failed'):
                logger.info(f"[Option B] Playwright apply: {job_url}")
                result = self.playwright_bot.apply_to_job(job_url, site, cover_letter)

        if result is None:
            result = {
                'url': job_url,
                'status': 'failed',
                'method': 'none',
                'error': 'No browser available',
                'timestamp': datetime.now().isoformat()
            }

        self.results.append(result)
        return result

    def apply_batch(self, jobs):
        """
        Apply to a batch of jobs.
        jobs: list of dicts with keys: jobUrl, title, company, score, site, cover_letter (optional)
        """
        applied = 0
        failed = 0
        skipped = 0

        for i, job in enumerate(jobs):
            url = job.get('jobUrl') or job.get('job_url', '')
            title = job.get('title', 'Unknown')
            company = job.get('company', 'Unknown')
            score = job.get('score', 0)
            site = job.get('site', 'linkedin')
            cover_letter = job.get('cover_letter')

            logger.info(f"\n[{i+1}/{len(jobs)}] {title} @ {company} (score: {score})")

            if score < 4.0:
                logger.info(f"  Skipping — score {score} below threshold")
                self.results.append({
                    'url': url, 'status': 'skipped_low_score',
                    'method': 'none', 'error': f'Score {score} < 4.0',
                    'timestamp': datetime.now().isoformat()
                })
                skipped += 1
                continue

            result = self.apply_to_job(url, site, cover_letter)

            if result['status'] == 'applied':
                applied += 1
            elif result['status'] in ('form_filled', 'external_form_filled'):
                applied += 1  # Partially applied
            else:
                failed += 1

            # Rate limiting — don't hammer the site
            time.sleep(5)

        summary = {
            'total': len(jobs),
            'applied': applied,
            'failed': failed,
            'skipped': skipped,
            'results': self.results
        }

        logger.info(f"\n=== BATCH COMPLETE: {applied} applied, {failed} failed, {skipped} skipped ===")
        return summary

    def close(self):
        self.linkedin_bot.close()
        self.playwright_bot.close()


# ============================================================
# CLI ENTRY POINT
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='Auto-Apply Bot')
    parser.add_argument('--job-url', help='Single job URL to apply to')
    parser.add_argument('--jobs-file', help='JSON file with list of jobs to apply to')
    parser.add_argument('--linkedin-email', help='LinkedIn email', default=os.environ.get('LINKEDIN_EMAIL'))
    parser.add_argument('--linkedin-password', help='LinkedIn password', default=os.environ.get('LINKEDIN_PASSWORD'))
    parser.add_argument('--headless', action='store_true', default=True, help='Run headless')
    parser.add_argument('--no-headless', action='store_true', help='Show browser')
    parser.add_argument('--min-score', type=float, default=4.0, help='Minimum score to apply')
    parser.add_argument('--output', help='Output JSON file for results', default='/tmp/apply_results.json')

    args = parser.parse_args()
    headless = not args.no_headless

    orchestrator = AutoApplyOrchestrator(
        linkedin_email=args.linkedin_email,
        linkedin_password=args.linkedin_password,
        headless=headless
    )

    if not orchestrator.init():
        logger.error("Failed to initialize any browser")
        sys.exit(1)

    try:
        if args.job_url:
            result = orchestrator.apply_to_job(args.job_url)
            print(json.dumps(result, indent=2))

        elif args.jobs_file:
            with open(args.jobs_file) as f:
                jobs = json.load(f)
            # Filter by min score
            jobs = [j for j in jobs if j.get('score', 0) >= args.min_score]
            summary = orchestrator.apply_batch(jobs)

            with open(args.output, 'w') as f:
                json.dump(summary, f, indent=2)
            print(json.dumps({
                'total': summary['total'],
                'applied': summary['applied'],
                'failed': summary['failed'],
                'skipped': summary['skipped']
            }, indent=2))

    finally:
        orchestrator.close()


if __name__ == '__main__':
    main()
