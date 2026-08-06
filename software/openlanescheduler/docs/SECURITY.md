# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities by emailing:
**security@lunarlanes.local** (replace with your actual security contact email)

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

### What to Include

Please include the following information in your report:

- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### Our Process

1. **Acknowledge** - We'll acknowledge your report within 48 hours
2. **Investigate** - We'll investigate and validate the vulnerability
3. **Fix** - We'll develop a fix and prepare a security advisory
4. **Notify** - We'll notify you when the fix is ready for review
5. **Release** - We'll release the patch and publish the security advisory
6. **Credit** - We'll credit you in the advisory (unless you prefer to remain anonymous)

### Timeline

- **Initial Response:** Within 48 hours
- **Investigation:** Within 7 days
- **Fix Development:** Within 30 days (critical issues prioritized)
- **Release:** As soon as fix is verified and tested

## Security Best Practices for Deployment

### Environment Variables

**Never commit sensitive information to version control:**
- API keys
- Service account credentials
- Database passwords
- Session secrets

Always use environment variables and keep `.env` files out of version control.

### Google Calendar Credentials

**API Key:**
- Restrict API key to specific domains/IPs
- Rotate keys regularly
- Monitor usage in Google Cloud Console

**Service Account:**
- Use principle of least privilege
- Grant minimum required calendar permissions
- Rotate service account keys annually
- Monitor service account activity

### Network Security

**In Production:**
- Always use HTTPS/TLS
- Configure CORS properly (don't use `origin: '*'` in production)
- Implement rate limiting
- Use Web Application Firewall (WAF)
- Keep dependencies updated

**Kubernetes Deployment:**
- Use network policies to restrict pod communication
- Run containers as non-root users
- Use secrets for sensitive configuration
- Enable pod security policies
- Regularly scan images for vulnerabilities

### Redis Security

**Configuration:**
- Set a strong password (`requirepass` in redis.conf)
- Bind to localhost or private network only
- Disable dangerous commands (FLUSHALL, KEYS, etc.)
- Enable encryption in transit (TLS)
- Regularly backup data

### Application Security

**Backend:**
- Validate all user input
- Sanitize data before storage
- Use parameterized queries (if SQL is added)
- Implement rate limiting
- Log security events

**Frontend:**
- Sanitize user-generated content
- Implement Content Security Policy (CSP)
- Use secure WebSocket connections (wss://)
- Validate data received from WebSocket
- Don't expose sensitive information in client code

## Known Security Considerations

### WebSocket Authentication

**Current Status:** WebSocket connections are unauthenticated

**Mitigation:**
- Deploy behind firewall/VPN for internal use
- Implement authentication tokens if exposing publicly
- Use network policies in Kubernetes

### State Validation

**Current Status:** Limited server-side validation of state changes

**Mitigation:**
- All state changes are validated before Google Calendar sync
- Consider adding more granular permission system
- Implement audit logging for state changes

### Google Calendar Integration

**Current Status:** Service account has full calendar access

**Mitigation:**
- Share calendar with service account only (not publicly)
- Monitor calendar activity logs
- Rotate credentials regularly
- Use separate calendar for testing/development

## Security Audit History

| Date       | Auditor | Findings | Status |
|------------|---------|----------|--------|
| 2026-02-15 | Internal | Credentials in docker-compose.yml | Fixed |

## Security Updates

Subscribe to security advisories:
- Watch this repository for security advisories
- Enable GitHub Dependabot alerts
- Monitor npm security advisories

## Vulnerability Disclosure Policy

We follow a **90-day disclosure policy**:

1. Researcher reports vulnerability privately
2. We acknowledge within 48 hours
3. We develop and test a fix
4. We release the fix in a security patch
5. After 90 days (or when fix is deployed), we publish advisory
6. We credit the researcher (if they wish)

### Hall of Fame

We recognize security researchers who responsibly disclose vulnerabilities:

<!-- Security researchers will be listed here -->

---

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [React Security](https://react.dev/learn/keeping-components-pure#local-mutation-your-components-little-secret)
- [Socket.IO Security](https://socket.io/docs/v4/security/)

---

**Thank you for helping keep Lunar Lanes secure!**
