import { firebaseConfig } from "./firebase-config.js";

const buttonHost = document.getElementById("google-login");
const status = document.getElementById("login-status");
const state = new URLSearchParams(location.search).get("state");
const googleIdentityScript = "https://accounts.google.com/gsi/client";

async function returnToArcade(idToken) {
  try {
    if (typeof idToken !== "string" || !idToken) {
      throw new Error("Google не вернул токен входа. Попробуй ещё раз.");
    }

    const response = await fetch(`/complete?state=${encodeURIComponent(state || "")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    });
    const resultData = await response.json();
    if (!response.ok) throw new Error(resultData.error || "Не удалось вернуться в Arcade.");
    status.textContent = "Вход выполнен. Вернись в Arcade.";
  } catch (error) {
    status.textContent = error.message || "Не удалось завершить вход в Arcade.";
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
    script.onerror = () => reject(new Error("Не удалось загрузить защищённую библиотеку входа Google. Проверь подключение к интернету."));
    document.head.append(script);
  });
}

async function initializeGoogleSignIn() {
  if (!firebaseConfig.googleClientId) {
    throw new Error("Не настроен Google Web Client ID в firebase-config.js.");
  }
  await loadGoogleIdentityServices();
  if (!window.google?.accounts?.id) {
    throw new Error("Библиотека Google Identity Services не загрузилась.");
  }
  window.google.accounts.id.initialize({
    client_id: firebaseConfig.googleClientId,
    callback: response => {
      buttonHost.hidden = true;
      status.textContent = "Завершаем защищённый вход...";
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

initializeGoogleSignIn().catch(error => {
  status.textContent = error.message || "Не удалось подготовить вход Google.";
  console.error("Could not initialize Google Identity Services:", error);
  buttonHost.hidden = true;
});
