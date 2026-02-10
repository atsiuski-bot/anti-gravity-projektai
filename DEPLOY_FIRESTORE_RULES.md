# Deploy Firestore Security Rules - Manual Steps

## The Issue
Your Firebase CLI credentials have expired, so I cannot automatically deploy the updated rules. You need to deploy them manually.

## What I Fixed

I updated `firestore.rules` line 42 from:
```javascript
allow read: if isAuthenticated();
```

To:
```javascript
allow read: if isAuthenticated() && request.auth.uid == userId;
```

**Why this matters:** The old rule allowed ANY authenticated user to read ANY user document. The new rule ensures users can ONLY read their OWN documents, which is more secure and fixes the permission error.

## How to Deploy (Choose One Method)

### Method 1: Using Firebase CLI (Recommended)

1. Open PowerShell/Terminal in your project directory
2. Re-authenticate with Firebase:
   ```bash
   firebase login --reauth
   ```
3. Deploy the rules:
   ```bash
   firebase deploy --only firestore:rules
   ```

### Method 2: Using Firebase Console (If CLI doesn't work)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project: **darbo-planavimas**
3. Click **Firestore Database** in left sidebar
4. Click **Rules** tab at the top
5. You'll see an editor - **copy the entire content** from your local `firestore.rules` file
6. Paste it into the editor
7. Click **Publish** button

## After Deployment

1. Close all browser tabs with your app
2. Clear browser cache (or hard refresh with Ctrl+Shift+R)
3. Try logging in again
4. The "Missing or insufficient permissions" error should be gone

## What This Fixes

✅ Users can read their own user documents
✅ Users CANNOT read other users' documents (security improvement)
✅ AuthContext can load user role and profile data
✅ App will function normally

The permission error you saw will disappear once these rules are deployed.
