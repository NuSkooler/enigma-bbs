/* jslint node: true */
'use strict';

/**
 * Security utility functions for ENiGMA½ BBS
 * 
 * This module provides security-focused utilities including input validation,
 * sanitization, and rate limiting to protect against common vulnerabilities.
 * 
 * @module security_util
 */

//  deps
const crypto = require('crypto');
const _ = require('lodash');

/**
 * Rate limiting implementation using sliding window
 * Protects against brute force and DoS attacks
 */
class RateLimiter {
    constructor(options = {}) {
        this.windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutes default
        this.maxAttempts = options.maxAttempts || 5;
        this.attempts = new Map(); // key -> [{timestamp}]
    }

    /**
     * Check if a key has exceeded rate limit
     * @param {string} key - Identifier (IP, username, etc.)
     * @returns {boolean} - true if rate limited
     */
    isRateLimited(key) {
        const now = Date.now();
        const attempts = this.attempts.get(key) || [];
        
        // Remove old attempts outside the window
        const recentAttempts = attempts.filter(
            timestamp => now - timestamp < this.windowMs
        );
        
        this.attempts.set(key, recentAttempts);
        
        return recentAttempts.length >= this.maxAttempts;
    }

    /**
     * Record an attempt for rate limiting
     * @param {string} key - Identifier (IP, username, etc.)
     */
    recordAttempt(key) {
        const now = Date.now();
        const attempts = this.attempts.get(key) || [];
        attempts.push(now);
        this.attempts.set(key, attempts);
    }

    /**
     * Reset attempts for a key (e.g., after successful authentication)
     * @param {string} key - Identifier to reset
     */
    reset(key) {
        this.attempts.delete(key);
    }

    /**
     * Clean up old entries periodically
     */
    cleanup() {
        const now = Date.now();
        for (const [key, attempts] of this.attempts.entries()) {
            const recentAttempts = attempts.filter(
                timestamp => now - timestamp < this.windowMs
            );
            if (recentAttempts.length === 0) {
                this.attempts.delete(key);
            } else {
                this.attempts.set(key, recentAttempts);
            }
        }
    }
}

/**
 * Validates and sanitizes file paths to prevent path traversal attacks
 * @param {string} filePath - The file path to validate
 * @param {string} baseDir - The base directory that should contain the file
 * @returns {Object} - {valid: boolean, sanitized: string, error: string}
 */
function validateFilePath(filePath, baseDir) {
    if (!filePath || typeof filePath !== 'string') {
        return { valid: false, error: 'Invalid file path provided' };
    }

    const paths = require('path');
    
    // Normalize and resolve the path
    const normalizedPath = paths.normalize(filePath);
    const resolvedPath = paths.resolve(baseDir, normalizedPath);
    const resolvedBase = paths.resolve(baseDir);
    
    // Check if the resolved path is within the base directory
    if (!resolvedPath.startsWith(resolvedBase + paths.sep) && 
        resolvedPath !== resolvedBase) {
        return { 
            valid: false, 
            error: 'Path traversal detected',
            sanitized: null 
        };
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
        /\.\./,  // Parent directory traversal
        /^\/etc/i,  // System directories
        /^\/root/i,
        /^\/usr/i,
        /^\/bin/i,
        /^\/sbin/i,
        /^\/sys/i,
        /^\/proc/i,
        /^c:\\/i,  // Windows system paths
        /^\\\\windows\\/i,
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(normalizedPath)) {
            return { 
                valid: false, 
                error: 'Suspicious path pattern detected',
                sanitized: null 
            };
        }
    }

    return { 
        valid: true, 
        sanitized: resolvedPath,
        error: null 
    };
}

/**
 * Validates username against security best practices
 * @param {string} username - Username to validate
 * @param {Object} options - Validation options
 * @returns {Object} - {valid: boolean, error: string}
 */
function validateUsername(username, options = {}) {
    const minLength = options.minLength || 2;
    const maxLength = options.maxLength || 32;
    
    if (!username || typeof username !== 'string') {
        return { valid: false, error: 'Username must be a string' };
    }

    if (username.length < minLength) {
        return { valid: false, error: `Username must be at least ${minLength} characters` };
    }

    if (username.length > maxLength) {
        return { valid: false, error: `Username must not exceed ${maxLength} characters` };
    }

    // Allow alphanumeric, underscore, hyphen, and period
    // Prevent SQL injection and command injection patterns
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validPattern.test(username)) {
        return { 
            valid: false, 
            error: 'Username contains invalid characters. Only alphanumeric, dot, underscore, and hyphen allowed' 
        };
    }

    // Prevent usernames that look like system commands or SQL keywords
    const forbiddenPatterns = [
        /^(root|admin|administrator|system|guest|test)$/i,
        /^(select|insert|update|delete|drop|create|alter|exec|execute)$/i,
        /\$\{/,  // Template injection
        /<script/i,  // XSS
        /\-\-/,  // SQL comment
        /;/,  // SQL statement separator
    ];

    for (const pattern of forbiddenPatterns) {
        if (pattern.test(username)) {
            return { valid: false, error: 'Username contains forbidden pattern' };
        }
    }

    return { valid: true, error: null };
}

/**
 * Validates email address with comprehensive security checks
 * @param {string} email - Email to validate
 * @returns {Object} - {valid: boolean, error: string}
 */
function validateEmail(email) {
    if (!email || typeof email !== 'string') {
        return { valid: false, error: 'Email must be a string' };
    }

    // Basic RFC 5322 compliant email regex
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    
    if (!emailPattern.test(email)) {
        return { valid: false, error: 'Invalid email format' };
    }

    // Length checks
    if (email.length > 254) {  // RFC 5321
        return { valid: false, error: 'Email address too long' };
    }

    const [localPart, domain] = email.split('@');
    
    if (localPart.length > 64) {  // RFC 5321
        return { valid: false, error: 'Email local part too long' };
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
        /<script/i,
        /javascript:/i,
        /\$\{/,
        /\.\./,
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(email)) {
            return { valid: false, error: 'Email contains suspicious pattern' };
        }
    }

    return { valid: true, error: null };
}

/**
 * Sanitizes HTML/script content from user input to prevent XSS
 * @param {string} input - Input to sanitize
 * @returns {string} - Sanitized input
 */
function sanitizeInput(input) {
    if (typeof input !== 'string') {
        return '';
    }

    // Remove script tags and their content
    let sanitized = input.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove event handlers
    sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]*/gi, '');
    
    // Remove javascript: protocol
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // Remove data: protocol (can be used for XSS)
    sanitized = sanitized.replace(/data:text\/html/gi, '');
    
    return sanitized.trim();
}

/**
 * Generate cryptographically secure random token
 * @param {number} bytes - Number of bytes (default: 32)
 * @returns {Promise<string>} - Hex encoded token
 */
function generateSecureToken(bytes = 32) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(bytes, (err, buffer) => {
            if (err) {
                return reject(err);
            }
            resolve(buffer.toString('hex'));
        });
    });
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - True if strings match
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }

    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
        return false;
    }

    try {
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (err) {
        return false;
    }
}

/**
 * Validates command arguments to prevent command injection
 * @param {Array<string>} args - Command arguments to validate
 * @returns {Object} - {valid: boolean, error: string, sanitized: Array}
 */
function validateCommandArgs(args) {
    if (!Array.isArray(args)) {
        return { valid: false, error: 'Arguments must be an array' };
    }

    const sanitized = [];
    
    // Dangerous patterns that could lead to command injection
    const dangerousPatterns = [
        /[;&|`$()]/,  // Shell metacharacters
        /\$\{/,  // Variable expansion
        /\$\(/,  // Command substitution
        /\n/,  // Newlines
        /\r/,  // Carriage returns
    ];

    for (const arg of args) {
        if (typeof arg !== 'string') {
            return { 
                valid: false, 
                error: 'All arguments must be strings',
                sanitized: [] 
            };
        }

        // Check for dangerous patterns
        for (const pattern of dangerousPatterns) {
            if (pattern.test(arg)) {
                return { 
                    valid: false, 
                    error: `Argument contains dangerous pattern: ${arg}`,
                    sanitized: [] 
                };
            }
        }

        sanitized.push(arg);
    }

    return { valid: true, error: null, sanitized };
}

/**
 * Validates SQL parameter to prevent SQL injection
 * Note: This is a defense-in-depth measure. Always use parameterized queries.
 * @param {*} value - Value to validate
 * @returns {Object} - {valid: boolean, error: string}
 */
function validateSqlParameter(value) {
    if (value === null || value === undefined) {
        return { valid: true, error: null };
    }

    const type = typeof value;
    
    // Only allow safe types
    if (!['string', 'number', 'boolean'].includes(type)) {
        return { valid: false, error: 'Invalid parameter type for SQL' };
    }

    if (type === 'string') {
        // Check for SQL injection patterns
        const sqlInjectionPatterns = [
            /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b)/gi,
            /--/,  // SQL comment
            /\/\*/,  // SQL comment start
            /\*\//,  // SQL comment end
            /;/,  // Statement separator
            /xp_/i,  // Extended stored procedures
        ];

        for (const pattern of sqlInjectionPatterns) {
            if (pattern.test(value)) {
                return { 
                    valid: false, 
                    error: 'Parameter contains SQL injection pattern' 
                };
            }
        }

        // Length check
        if (value.length > 10000) {
            return { valid: false, error: 'Parameter too long' };
        }
    }

    return { valid: true, error: null };
}

/**
 * Security headers for HTTP responses
 * @returns {Object} - Security headers
 */
function getSecurityHeaders() {
    return {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    };
}

module.exports = {
    RateLimiter,
    validateFilePath,
    validateUsername,
    validateEmail,
    sanitizeInput,
    generateSecureToken,
    timingSafeEqual,
    validateCommandArgs,
    validateSqlParameter,
    getSecurityHeaders,
};
