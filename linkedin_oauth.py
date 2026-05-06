#!/usr/bin/env python3
"""
LinkedIn OAuth2 Authorization Flow.
1. Start a local HTTP server for the callback
2. Print the auth URL for user to open in browser
3. Capture the authorization code
4. Exchange for access token
5. Save token to .linkedin_token
"""

import http.server
import urllib.parse
import json
import os
import sys
import requests

CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '')
CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '')
REDIRECT_PORT = int(os.environ.get('LINKEDIN_REDIRECT_PORT', '8585'))
REDIRECT_HOST = os.environ.get('LINKEDIN_REDIRECT_HOST', 'localhost')
REDIRECT_URI = os.environ.get('LINKEDIN_REDIRECT_URI', f'http://{REDIRECT_HOST}:{REDIRECT_PORT}/callback')

if not CLIENT_ID or not CLIENT_SECRET:
    print('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET env vars are required.', file=sys.stderr)
    sys.exit(1)
SCOPES = 'profile email openid'
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.linkedin_token')

auth_code = None


class OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if 'code' in params:
            auth_code = params['code'][0]
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'''
                <html><body style="font-family:sans-serif;text-align:center;padding:50px">
                <h1>LinkedIn Authorization Successful!</h1>
                <p>You can close this tab. The bot is getting your access token...</p>
                </body></html>
            ''')
        elif 'error' in params:
            self.send_response(400)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            error = params.get('error_description', params.get('error', ['Unknown']))[0]
            self.wfile.write(f'<html><body><h1>Error: {error}</h1></body></html>'.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logs


def get_auth_url():
    return (
        f'https://www.linkedin.com/oauth/v2/authorization'
        f'?response_type=code'
        f'&client_id={CLIENT_ID}'
        f'&redirect_uri={urllib.parse.quote(REDIRECT_URI)}'
        f'&scope={urllib.parse.quote(SCOPES)}'
        f'&state=jobbot_auth'
    )


def exchange_code_for_token(code):
    resp = requests.post('https://www.linkedin.com/oauth/v2/accessToken', data={
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': REDIRECT_URI,
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    })
    if resp.status_code == 200:
        return resp.json()
    else:
        print(f'Token exchange failed: {resp.status_code} {resp.text}')
        return None


def main():
    auth_url = get_auth_url()
    print('\n' + '='*60)
    print('LINKEDIN AUTHORIZATION')
    print('='*60)
    print(f'\nOpen this URL in your browser:\n')
    print(auth_url)
    print(f'\nWaiting for callback on port {REDIRECT_PORT}...\n')

    server = http.server.HTTPServer(('0.0.0.0', REDIRECT_PORT), OAuthCallbackHandler)
    server.timeout = 300  # 5 min timeout

    while auth_code is None:
        server.handle_request()

    print(f'Got authorization code: {auth_code[:20]}...')
    print('Exchanging for access token...')

    token_data = exchange_code_for_token(auth_code)
    if token_data:
        # Save token
        with open(TOKEN_FILE, 'w') as f:
            json.dump(token_data, f, indent=2)
        print(f'\nAccess token saved to {TOKEN_FILE}')
        print(f'Token expires in: {token_data.get("expires_in", "?")} seconds')

        # Test the token
        headers = {'Authorization': f'Bearer {token_data["access_token"]}'}
        me = requests.get('https://api.linkedin.com/v2/userinfo', headers=headers)
        if me.status_code == 200:
            profile = me.json()
            print(f'Authenticated as: {profile.get("name", "?")} ({profile.get("email", "?")})')
        else:
            print(f'Profile check: {me.status_code}')
    else:
        print('Failed to get access token')
        sys.exit(1)


if __name__ == '__main__':
    main()
