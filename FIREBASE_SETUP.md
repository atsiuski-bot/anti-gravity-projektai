# Firebase Console Configuration for OAuth Redirect

## Issue

If you see this error in Opera or other browsers:
```
The navigation route /login is not being used, since the URL being navigated to doesn't match the allowlist.
```

This means the OAuth redirect URIs need to be configured in the Firebase Console.

## Solution

### Step 1: Open Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: **darbo-planavimas**

### Step 2: Configure OAuth Redirect URIs

1. In the left sidebar, click on **Authentication**
2. Click on the **Settings** tab (gear icon) at the top
3. Scroll down to **Authorized domains**
4. Click **Add domain** if your domain isn't listed

### Step 3: Add Google Provider Redirect URIs

1. Click on **Sign-in method** tab
2. Find **Google** in the Sign-in providers list
3. Click on **Google** to edit
4. In the **Authorized redirect URIs** section, add:
   - For local development: `http://localhost:5173`
   - For production: Your production domain (e.g., `https://yourdomain.com`)

5. Click **Save**

### Current Workaround

The app now has a **fallback mechanism** - if redirect authentication fails in Opera, it automatically tries popup-based authentication instead. This means:
- ✅ Opera users can still log in using popup (same as Chrome/Firefox)
- ⚠️ You'll see a console warning about the redirect failing
- ✅ No impact on user experience

### Recommended Next Steps

For the best Opera experience:
1. Complete the Firebase Console configuration above
2. Test in Opera - redirect should work without falling back to popup
3. Console should show: `Auth: Opera browser detected, attempting redirect flow...`

## Notes

- The localhost redirect should already work for development
- If you're testing on a different port or domain, add that specific URL
- The error is harmless with the fallback in place, but configuring Firebase properly is recommended
