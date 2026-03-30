(function () {
  const ENCRYPTED_BLOB = "jI4W3070+mUEjs20lxJ1lJBB4GsCpU22/a+osLlE0xW7z/bN27nvT8Q3/tml8SiNveAeJrAzuFGd00pbjsayFt0LC0MBzOlWr0d8K1bHrJo5TR2fnXxqJ5MLtToGt3oN5OFBxiyel8lMa2Amv9KdUFbm78fdbex6rd99cQzzJk+5ZCz4pN+twFHbtf84/ywLPR/BQC88edvn75R5kQoFYr4EL0FjWk6lNhEOgDB6GsYPwWPtVbD2fjV+9F1FfubWhNBZz5EzwBxxMoKUHHPZrYEVReY1+GzHPbpx3T50hm8uhc8siRFBNh1ZcGfBSGYGZzeYjWx5qTaMniJ4hEyvUORPF1NkOkbY6J0C5w4oTlIIfyp2x9Z11L98lQTMO+59dJMBydFEenaH6MINVlkPIxmFY0pjKcMfKHVMlDIwtOlpipVKE8S055ay4k8bzvs="; // ← paste from the encrypt step

  const COOKIE_NAME  = "rsm_access";
  const COOKIE_DAYS  = 3650;
  const VERIFY_KEY   = "_key";
  const VERIFY_VALUE = "ruben";

  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Strict`;
  }

  function getCookie(name) {
    return document.cookie.split(";").reduce((acc, c) => {
      const [k, v] = c.trim().split("=");
      return k === name ? v : acc;
    }, null);
  }

  async function decryptConfig(password) {
    const raw  = Uint8Array.from(atob(ENCRYPTED_BLOB), c => c.charCodeAt(0));
    const salt = raw.slice(0, 16);
    const iv   = raw.slice(16, 28);
    const data = raw.slice(28);

    const keyMaterial = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name:"PBKDF2", salt, iterations:200000, hash:"SHA-256" },
      keyMaterial, { name:"AES-GCM", length:256 }, false, ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt({ name:"AES-GCM", iv }, key, data);
    const config    = JSON.parse(new TextDecoder().decode(decrypted));

    if (config[VERIFY_KEY] !== VERIFY_VALUE) {
      throw new Error("Verification failed");
    }

    delete config[VERIFY_KEY];
    return config;
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function initWithConfig(config) {
    await Promise.all([
      loadScript("https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js"),
      loadScript("https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore-compat.js"),
      loadScript("https://www.gstatic.com/firebasejs/9.22.1/firebase-storage-compat.js"),
    ]);
    firebase.initializeApp(config);
  }

  function buildGate() {
    const overlay = document.createElement("div");
    overlay.id = "gate-overlay";
    overlay.innerHTML = `
      <div id="gate-box">
        <img src="image/rub.jpg" alt="Ruben" id="gate-avatar">
        <h2 id="gate-title">Ruben Sticker Map</h2>
        <p id="gate-sub">Voer de toegangscode in</p>
        <div id="gate-input-wrap">
          <input id="gate-input" type="password" placeholder="Code..."
            autocomplete="off" autocorrect="off" autocapitalize="off"
            spellcheck="false" maxlength="40">
          <button id="gate-btn">→</button>
        </div>
        <p id="gate-err"></p>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById("gate-input").focus(), 100);

    let busy = false;

    async function attempt() {
      if (busy) return;
      const val = document.getElementById("gate-input").value.trim();
      if (!val) return;
      busy = true;
      document.getElementById("gate-btn").textContent = "...";

      try {
        const config = await decryptConfig(val);
        await initWithConfig(config);
        setCookie(COOKIE_NAME, btoa(val), COOKIE_DAYS);
        overlay.classList.add("gate-fade-out");
        setTimeout(() => overlay.remove(), 600);
      } catch {
        document.getElementById("gate-err").textContent = "❌ Verkeerde code.";
        document.getElementById("gate-input").value = "";
        overlay.classList.add("gate-shake");
        setTimeout(() => overlay.classList.remove("gate-shake"), 500);
        document.getElementById("gate-btn").textContent = "→";
        busy = false;
      }
    }

    document.getElementById("gate-btn").addEventListener("click", attempt);
    document.getElementById("gate-input").addEventListener("keydown", e => {
      if (e.key === "Enter") attempt();
      document.getElementById("gate-err").textContent = "";
    });
  }

  const saved = getCookie(COOKIE_NAME);
  if (saved) {
    decryptConfig(atob(saved))
      .then(initWithConfig)
      .catch(() => {
        document.cookie = `${COOKIE_NAME}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
        buildGate();
      });
  } else {
    buildGate();
  }
})();
