# Security Policy

## Overview

ENiGMA½ BBS takes security seriously. This document outlines our security practices, recent improvements, and guidelines for reporting vulnerabilities.

## Recent Security Improvements

### 1. Password Hashing Enhancement (Critical)

**Issue**: The system was using PBKDF2 with SHA-1 and only 1,000 iterations, which is below current security standards.

**Fix**: Upgraded to PBKDF2-SHA256 with 100,000 iterations
- **File**: `core/user.js`
- **Impact**: Significantly increases resistance to brute-force and rainbow table attacks
- **Note**: Existing passwords will be migrated on next login using the new algorithm

**OWASP Recommendation**: PBKDF2-SHA256 with at least 100,000 iterations

### 2. Rate Limiting (High)

**Issue**: No rate limiting on password reset requests allowed potential abuse and brute force attacks.

**Fix**: Implemented comprehensive rate limiting
- **File**: `core/web_password_reset.js`
- Password reset email requests: 3 per 15 minutes per username
- Password reset attempts: 5 per hour per IP address
- **Module**: New `security_util.js` provides RateLimiter class

### 3. Timing Attack Prevention (High)

**Issue**: Password reset token comparison was vulnerable to timing attacks.

**Fix**: Implemented constant-time comparison
- **File**: `core/web_password_reset.js`
- Uses `crypto.timingSafeEqual()` for token validation
- Prevents attackers from guessing valid tokens through timing analysis

### 4. Input Validation & Sanitization (High)

**Issue**: Insufficient input validation across various modules could lead to injection attacks.

**Fix**: Created comprehensive validation utilities
- **File**: `core/security_util.js`
- Validates usernames, emails, file paths, SQL parameters
- Sanitizes user input to prevent XSS attacks
- Validates command arguments to prevent command injection

### 5. Path Traversal Prevention (Critical)

**Issue**: Archive extraction and file operations could be vulnerable to path traversal attacks.

**Fix**: Added strict path validation
- **File**: `core/archive_util.js`
- Validates all file paths before operations
- Prevents `../` and other traversal patterns
- Ensures operations stay within designated directories

### 6. Command Injection Prevention (Critical)

**Issue**: Archive operations with user-controlled input could lead to command injection.

**Fix**: Added command argument validation
- **File**: `core/archive_util.js`
- Validates all arguments passed to external processes
- Blocks shell metacharacters (`;`, `|`, `&`, `` ` ``, `$()`, etc.)
- Prevents variable expansion and command substitution

### 7. Security Headers (Medium)

**Issue**: HTTP responses lacked modern security headers.

**Fix**: Added comprehensive security headers
- **File**: `core/servers/content/web.js`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- `Referrer-Policy`

### 8. Token Expiration (Medium)

**Issue**: Password reset tokens didn't have explicit expiration validation.

**Fix**: Added 24-hour token expiration
- **File**: `core/web_password_reset.js`
- Tokens automatically expire after 24 hours
- Expired tokens are properly validated and rejected

### 9. DoS Prevention (Medium)

**Issue**: No protection against large POST bodies in password reset.

**Fix**: Added body size limits
- **File**: `core/web_password_reset.js`
- 10KB limit on POST body size
- Connection terminated on exceeding limit

## Security Best Practices

### For Administrators

1. **Keep Dependencies Updated**
   ```bash
   npm audit
   npm update
   ```

2. **Use Strong Passwords**
   - Minimum 12 characters
   - Mix of uppercase, lowercase, numbers, and symbols
   - Avoid common patterns

3. **Enable HTTPS**
   - Configure SSL/TLS certificates
   - Use TLS 1.2 or higher
   - Disable weak cipher suites

4. **Regular Backups**
   - Backup database files regularly
   - Store backups securely
   - Test restore procedures

5. **Monitor Logs**
   - Review authentication failures
   - Watch for suspicious patterns
   - Set up log rotation

6. **Firewall Configuration**
   - Limit exposed ports
   - Use IP whitelisting where appropriate
   - Configure fail2ban or similar

### For Developers

1. **Input Validation**
   ```javascript
   const { validateUsername, sanitizeInput } = require('./core/security_util');
   
   const validation = validateUsername(userInput);
   if (!validation.valid) {
       return callback(new Error(validation.error));
   }
   ```

2. **Path Validation**
   ```javascript
   const { validateFilePath } = require('./core/security_util');
   
   const pathCheck = validateFilePath(userPath, baseDirectory);
   if (!pathCheck.valid) {
       return callback(new Error(pathCheck.error));
   }
   ```

3. **Rate Limiting**
   ```javascript
   const { RateLimiter } = require('./core/security_util');
   
   const limiter = new RateLimiter({
       windowMs: 15 * 60 * 1000,
       maxAttempts: 5
   });
   
   if (limiter.isRateLimited(identifier)) {
       return callback(new Error('Rate limit exceeded'));
   }
   limiter.recordAttempt(identifier);
   ```

4. **Timing-Safe Comparisons**
   ```javascript
   const { timingSafeEqual } = require('./core/security_util');
   
   if (!timingSafeEqual(userToken, storedToken)) {
       return callback(new Error('Invalid token'));
   }
   ```

5. **Command Execution**
   - Always validate command arguments
   - Never use user input directly in shell commands
   - Use parameterized execution where possible
   ```javascript
   const { validateCommandArgs } = require('./core/security_util');
   
   const validation = validateCommandArgs(args);
   if (!validation.valid) {
       return callback(new Error(validation.error));
   }
   ```

6. **SQL Queries**
   - Always use parameterized queries
   - Never concatenate user input into SQL
   ```javascript
   // ✓ GOOD
   db.run('SELECT * FROM users WHERE id = ?', [userId], callback);
   
   // ✗ BAD
   db.run(`SELECT * FROM users WHERE id = ${userId}`, callback);
   ```

## Reporting Vulnerabilities

### How to Report

If you discover a security vulnerability, please:

1. **DO NOT** create a public GitHub issue
2. Email security details to: [SECURITY_EMAIL_HERE]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **24 hours**: Initial response acknowledging receipt
- **7 days**: Assessment and triage
- **30 days**: Fix development and testing
- **Coordinated disclosure**: Public announcement after fix is deployed

### Bug Bounty

Currently, we do not have a formal bug bounty program. Security researchers who responsibly disclose vulnerabilities will be acknowledged in release notes and security advisories (with permission).

## Security Checklist

### For New Installations

- [ ] Change default credentials
- [ ] Configure HTTPS/SSL
- [ ] Review and adjust password policies
- [ ] Enable logging
- [ ] Configure firewall rules
- [ ] Set up regular backups
- [ ] Review configuration files for sensitive data
- [ ] Disable unnecessary services/ports
- [ ] Set appropriate file permissions
- [ ] Configure rate limiting (if applicable)

### For Updates

- [ ] Backup current installation
- [ ] Review changelog for security updates
- [ ] Test in non-production environment
- [ ] Update dependencies
- [ ] Verify security configurations
- [ ] Monitor logs after update

## Security Resources

### OWASP Top 10 (2021)

1. Broken Access Control
2. Cryptographic Failures
3. Injection
4. Insecure Design
5. Security Misconfiguration
6. Vulnerable and Outdated Components
7. Identification and Authentication Failures
8. Software and Data Integrity Failures
9. Security Logging and Monitoring Failures
10. Server-Side Request Forgery (SSRF)

### Additional Reading

- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [CWE Top 25 Most Dangerous Software Weaknesses](https://cwe.mitre.org/top25/)

## Compliance

### Data Protection

- User passwords are hashed using PBKDF2-SHA256
- Sensitive data should not be logged
- Session tokens are cryptographically random
- Password reset tokens expire after 24 hours

### Audit Trail

- Authentication attempts are logged
- Failed logins trigger rate limiting
- Administrative actions should be logged
- Log files should be protected and rotated

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-10-25 | Initial security improvements |

## Contact

For security-related questions or concerns:
- GitHub Issues: [https://github.com/NuSkooler/enigma-bbs/issues](https://github.com/NuSkooler/enigma-bbs/issues)
- Security Email: [CONFIGURE_SECURITY_EMAIL]

---

**Note**: This security policy is a living document and will be updated as new security measures are implemented.
