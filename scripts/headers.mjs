export const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self' https://accounts.google.com/gsi/",
  "connect-src 'self' https://accounts.google.com/gsi/", "frame-src https://accounts.google.com/gsi/",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/ https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: https:",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
