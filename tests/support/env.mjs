// Loaded with `node --import` before regression tests. Fictional origins only:
// a fresh installation leaves the payment gateway unset, so tests opt in here.
process.env.NODEMAIL_SITE_ORIGIN = 'https://app.example.test';
process.env.NODEMAIL_PUBLIC_ORIGIN = 'https://app.example.test';
process.env.NODEMAIL_GMPAY_ORIGIN = 'https://pay.example.test';
