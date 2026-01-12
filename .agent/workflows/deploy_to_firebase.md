---
description: How to build and deploy the application to Firebase Hosting
---
This workflow guides you through deploying your React application to Firebase Hosting.

### Prerequisites
- You must have `npm` installed (which you do).
- You must have a Firebase project created in the [Firebase Console](https://console.firebase.google.com/).

### Steps

1.  **Install Firebase Tools** (if not already installed)
    Run this command to install the Firebase CLI globally:
    ```bash
    npm install -g firebase-tools
    ```

2.  **Login to Firebase**
    Log in to your Google account via the CLI:
    ```bash
    firebase login
    ```

3.  **Initialize Hosting**
    Set up the hosting configuration. Run this in your project folder:
    ```bash
    firebase init hosting
    ```
    - Select **"Use an existing project"** and choose your project.
    - **What do you want to use as your public directory?** Type `dist` (Vite's default build folder).
    - **Configure as a single-page app (rewrite all urls to /index.html)?** Type `Yes` (Important for React Router).
    - **Set up automatic builds and deploys with GitHub?** Type `No` (unless you want that).
    - **File public/index.html already exists. Overwrite?** Type `No`.

4.  **Build the Application**
    Create the production build:
    // turbo
    ```bash
    npm run build
    ```

5.  **Deploy**
    Upload the `dist` folder to Firebase:
    // turbo
    ```bash
    firebase deploy
    ```

Your app will be live at the URL shown in the terminal (usually `https://<your-project-id>.web.app`).
