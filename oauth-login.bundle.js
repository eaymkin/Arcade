(() => {
  // firebase-config.js
  var firebaseConfig = {
    apiKey: "AIzaSyDMYdWRxnl2mhChWQtwS_t7PU6Hsdl1EhU",
    authDomain: "stable-arch-512810-p8.firebaseapp.com",
    projectId: "stable-arch-512810-p8",
    appId: "1:962311392208:web:c712ddf76673fc1ec4c7d5",
    googleClientId: "962311392208-jjsifj20tfh9bkv41b3q6bsi6uifd3cd.apps.googleusercontent.com"
  };

  // oauth-login.js
  var buttonHost = document.getElementById("google-login");
  var status = document.getElementById("login-status");
  var state = new URLSearchParams(location.search).get("state");
  var googleIdentityScript = "https://accounts.google.com/gsi/client";
  async function returnToArcade(idToken) {
    try {
      if (typeof idToken !== "string" || !idToken) {
        throw new Error("Google \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0442\u043E\u043A\u0435\u043D \u0432\u0445\u043E\u0434\u0430. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439 \u0435\u0449\u0451 \u0440\u0430\u0437.");
      }
      const response = await fetch(`/complete?state=${encodeURIComponent(state || "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      });
      const resultData = await response.json();
      if (!response.ok) throw new Error(resultData.error || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u0435\u0440\u043D\u0443\u0442\u044C\u0441\u044F \u0432 Arcade.");
      status.textContent = "\u0412\u0445\u043E\u0434 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D. \u0412\u0435\u0440\u043D\u0438\u0441\u044C \u0432 Arcade.";
    } catch (error) {
      status.textContent = error.message || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0432\u0445\u043E\u0434 \u0432 Arcade.";
      console.error("Could not return Google sign-in result to Arcade:", error);
      buttonHost.hidden = false;
    }
  }
  function loadGoogleIdentityServices() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = googleIdentityScript;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u0443\u044E \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0443 \u0432\u0445\u043E\u0434\u0430 Google. \u041F\u0440\u043E\u0432\u0435\u0440\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043A \u0438\u043D\u0442\u0435\u0440\u043D\u0435\u0442\u0443."));
      document.head.append(script);
    });
  }
  async function initializeGoogleSignIn() {
    if (!firebaseConfig.googleClientId) {
      throw new Error("\u041D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D Google Web Client ID \u0432 firebase-config.js.");
    }
    await loadGoogleIdentityServices();
    if (!window.google?.accounts?.id) {
      throw new Error("\u0411\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0430 Google Identity Services \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430\u0441\u044C.");
    }
    window.google.accounts.id.initialize({
      client_id: firebaseConfig.googleClientId,
      callback: (response) => {
        buttonHost.hidden = true;
        status.textContent = "\u0417\u0430\u0432\u0435\u0440\u0448\u0430\u0435\u043C \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u044B\u0439 \u0432\u0445\u043E\u0434...";
        returnToArcade(response.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true
    });
    window.google.accounts.id.renderButton(buttonHost, {
      type: "standard",
      theme: "filled_blue",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: 304
    });
  }
  initializeGoogleSignIn().catch((error) => {
    status.textContent = error.message || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u0432\u0445\u043E\u0434 Google.";
    console.error("Could not initialize Google Identity Services:", error);
    buttonHost.hidden = true;
  });
})();
