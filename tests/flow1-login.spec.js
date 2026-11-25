const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('[TC-6434662] Flow 1: valid user can sign in and see their account profile', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Profile Information' })).toBeVisible();
  await expect(page.getByText(process.env.TEST_USER, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
});
