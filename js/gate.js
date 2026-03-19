/* ── Access Gate ── */
(function () {
  const CORRECT_HASH = "6c94e35ccc352d4e9ef0b99562cff995a5741ce8de8ad11b568892934daee366";
  const COOKIE_NAME  = "rsm_access";
  const COOKIE_DAYS  = 3650;

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
  async function sha256(msg) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  if (getCookie(COOKIE_NAME) === "granted") return;

  const overlay = document.createElement("div");
  overlay.id = "gate-overlay";
  overlay.innerHTML = `
    <div id="gate-box">
      <img src="image/rub.jpg" alt="Ruben" id="gate-avatar">
      <h2 id="gate-title">Ruben Sticker Map</h2>
      <p id="gate-sub">Voer de toegangscode in</p>
      <div id="gate-input-wrap">
        <input id="gate-input" type="text" placeholder="Code..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" maxlength="40">
        <button id="gate-btn">→</button>
      </div>
      <p id="gate-err"></p>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById("gate-input").focus(), 100);

  let attempts = 0;
  async function attempt() {
    const val = document.getElementById("gate-input").value.trim();
    if (!val) return;
    const hash = await sha256(val);
    if (hash === CORRECT_HASH) {
      setCookie(COOKIE_NAME, "granted", COOKIE_DAYS);
      overlay.classList.add("gate-fade-out");
      setTimeout(() => overlay.remove(), 600);
    } else {
      attempts++;
      const err = document.getElementById("gate-err");
      err.textContent = attempts >= 3 ? "❌ Verkeerde code. Vraag Ruben!" : "❌ Verkeerde code.";
      document.getElementById("gate-input").value = "";
      overlay.classList.add("gate-shake");
      setTimeout(() => overlay.classList.remove("gate-shake"), 500);
    }
  }

  document.getElementById("gate-btn").addEventListener("click", attempt);
  document.getElementById("gate-input").addEventListener("keydown", e => {
    if (e.key === "Enter") attempt();
    document.getElementById("gate-err").textContent = "";
  });
})();
