import { describe, it, expect, afterEach, vi } from 'vitest';

// `isProd` inside EmailService.ts is captured once at module load, so each case needs a fresh
// module instance (vi.resetModules) after stubbing NODE_ENV, not just a re-assigned env var.
describe('isEmailConfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is always true in dev — email delivery falls back to console logging', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(true);
  });

  it('is false in production when Resend env vars are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_FROM', '');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(false);
  });

  it('is true in production once both Resend env vars are set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_FROM', 'noreply@example.com');
    vi.stubEnv('RESEND_API_KEY', 're_key');
    vi.resetModules();
    const { isEmailConfigured } = await import('../src/auth/EmailService.js');
    expect(isEmailConfigured()).toBe(true);
  });
});
