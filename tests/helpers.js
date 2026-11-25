// Shared helpers for the Playwright specs.
// Recreated after the original file went missing; selectors come from the live login page
// (https://ecommercebs.vercel.app/login) as inspected in this session.

/**
 * Signs in with the TEST_USER / TEST_PASS credentials from .env and waits for the
 * "Profile Information" heading on the account page.
 */
async function login(page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email Address' }).fill(process.env.TEST_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.TEST_PASS);
  // Scope to the form: other "Sign In ..." buttons (OTP) live next to it.
  await page.locator('form').getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByRole('heading', { name: 'Profile Information' }).waitFor();
}

module.exports = { login };
