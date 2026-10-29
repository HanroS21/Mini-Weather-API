/* ---------- 1. Config & helpers ---------- */
const SERVER_URL = "http://localhost:5000";
const TOKEN_KEY = "miniweather.token";
const USER_KEY = "miniweather.user";

const $ = (id) => document.getElementById(id);

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, onClick) {
  const button = el("button", `ghost small ${className || ""}`.trim(), label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function setMessage(node, message, isError = true) {
  node.textContent = message;
  node.classList.toggle("is-error", isError);
  node.hidden = !message;
}

function getStoredUser() {
  try { return JSON.parse(store.get(USER_KEY) || "null"); } catch { return null; }
}

/* ---------- 2. Theme (light / dark) ---------- */
const THEME_KEY = "miniweather.theme";
const themeToggle = $("theme-toggle");
const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function currentTheme() {
  return document.documentElement.dataset.theme || (systemPrefersDark.matches ? "dark" : "light");
}

function updateThemeButton() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  themeToggle.textContent = next === "dark" ? "Dark mode" : "Light mode";
  themeToggle.setAttribute("aria-label", `Switch to ${next} mode`);
}

themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set(THEME_KEY, next);
  updateThemeButton();
});

// Until the person picks a theme, the page follows the system setting.
systemPrefersDark.addEventListener("change", updateThemeButton);
updateThemeButton();

/* ---------- 3. State & elements ---------- */
let saved = [];
let currentCity = "";
let currentWeather = null;
let editingId = null;
let clockTimer = null;

const authView = $("auth-view");
const appView = $("app-view");
const loginSection = $("login-section");
const signupSection = $("signup-section");
const loginForm = $("login-form");
const loginBtn = $("login-btn");
const authStatus = $("auth-status");
const signupForm = $("signup-form");
const signupBtn = $("signup-btn");
const signupStatus = $("signup-status");
const signupSubtitle = $("signup-subtitle");

const searchForm = $("search");
const cityInput = $("city");
const searchBtn = $("search-btn");
const statusEl = $("status");
const emptyEl = $("empty-state");
const resultEl = $("result");
const saveBtn = $("save-city");
const saveMsg = $("save-msg");
const greetingEl = $("greeting");

const savedList = $("saved-list");
const savedEmpty = $("saved-empty");
const savedCount = $("saved-count");

const activityList = $("activity-list");
const activityEmpty = $("activity-empty");

const passwordForm = $("password-form");
const passwordStatus = $("password-status");

const createUserForm = $("create-user-form");
const adminStatus = $("admin-status");
const usersList = $("users-list");

const setStatus = (message, isError = false) => setMessage(statusEl, message, isError);
const setSaveMsg = (message, isError = true) => setMessage(saveMsg, message, isError);

// Pages are <section class="page" data-page="..."> elements.
const PAGES = ["dashboard", "activity", "account", "users"];
const pageEls = Object.fromEntries(
  [...document.querySelectorAll(".page[data-page]")].map((node) => [node.dataset.page, node])
);

/* ---------- 4. API ---------- */
async function request(path, { method = "GET", body, auth = true } = {}) {
  let response;
  try {
    response = await fetch(SERVER_URL + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(auth ? { Authorization: `Bearer ${store.get(TOKEN_KEY) || ""}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    console.error("Request failed:", SERVER_URL + path, err);
    throw new Error("Can't reach the server. Make sure it is running on port 5000.");
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && auth) {
    leaveApp("Your session expired. Sign in again.");
    throw new Error("Session expired.");
  }
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}

/* ---------- 5. Sign in / sign up ---------- */

// Switches between the sign-in and sign-up forms.
function showAuthMode(mode) {
  const signingUp = mode === "signup";
  loginSection.hidden = signingUp;
  signupSection.hidden = !signingUp;
  setMessage(authStatus, "");
  setMessage(signupStatus, "");
  (signingUp ? $("signup-username") : $("auth-username")).focus();
}

$("show-signup").addEventListener("click", () => showAuthMode("signup"));
$("show-login").addEventListener("click", () => showAuthMode("login"));

// Tells the sign-up page whether the next account will be the administrator.
async function loadSetupStatus() {
  try {
    const { needsSetup } = await request("/auth/setup-status", { auth: false });
    signupSubtitle.textContent = needsSetup
      ? "You're setting up Mini Weather. This account will be the administrator."
      : "Choose a username and password you'll use to sign in.";
  } catch {
    // Keep the default text if the server can't be reached.
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  if (!username || !password) return setMessage(authStatus, "Enter your username and password.");

  loginBtn.disabled = true;
  setMessage(authStatus, "Signing in…", false);
  try {
    const data = await request("/auth/login", { method: "POST", body: { username, password }, auth: false });
    store.set(TOKEN_KEY, data.access_token);
    store.set(USER_KEY, JSON.stringify(data.user));
    loginForm.reset();
    setMessage(authStatus, "");
    enterApp(data.user);
  } catch (err) {
    setMessage(authStatus, err.message);
  } finally {
    loginBtn.disabled = false;
  }
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("signup-username").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;
  const confirm = $("signup-confirm").value;

  if (password.length < 12) return setMessage(signupStatus, "Password must be at least 12 characters.");
  if (password !== confirm) return setMessage(signupStatus, "The passwords do not match.");

  signupBtn.disabled = true;
  setMessage(signupStatus, "Creating account…", false);
  try {
    const data = await request("/auth/signup", {
      method: "POST",
      body: { username, email, password },
      auth: false
    });
    signupForm.reset();
    showAuthMode("login");
    $("auth-username").value = username; // pre-fill so they only type the password
    setMessage(authStatus, data.message, false);
    $("auth-password").focus();
  } catch (err) {
    setMessage(signupStatus, err.message);
  } finally {
    signupBtn.disabled = false;
  }
});

/* ---------- 6. Routing & app shell ---------- */

function enterApp(user) {
  $("user-name").textContent = user.username;
  $("role-label").textContent = user.role === "admin" ? "Administrator" : "";

  // Only administrators see the Users link.
  document.querySelectorAll("[data-admin-only]").forEach((node) => {
    node.hidden = user.role !== "admin";
  });

  authView.hidden = true;
  appView.hidden = false;

  resetDashboard();
  setGreeting(user.username);
  loadSaved();
  showPage();
  cityInput.focus();
}

function leaveApp(message = "") {
  store.del(TOKEN_KEY);
  store.del(USER_KEY);

  appView.hidden = true;
  authView.hidden = false;
  showAuthMode("login");

  resetDashboard();
  activityList.replaceChildren();
  usersList.replaceChildren();

  setMessage(authStatus, message);
  $("auth-password").value = "";
}

function resetDashboard() {
  currentCity = "";
  currentWeather = null;
  saved = [];
  editingId = null;
  stopClock();
  resultEl.hidden = true;
  emptyEl.hidden = false;
  setStatus("");
  renderSaved();
}

function setGreeting(username) {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  greetingEl.textContent = `${part}, ${username}`;
}

$("signout").addEventListener("click", () => leaveApp());

// The current page comes from the hash, e.g. #/activity. Unknown hashes go to the weather page.
function currentPage() {
  const name = location.hash.replace(/^#\/?/, "");
  return PAGES.includes(name) ? name : "dashboard";
}

function showPage() {
  if (!store.get(TOKEN_KEY)) return; // signed out: the sign-in view is shown instead

  const user = getStoredUser();
  let page = currentPage();
  if (page === "users" && user?.role !== "admin") page = "dashboard";

  // Keep the address bar in step with the page without adding a history entry.
  if (location.hash !== `#/${page}`) history.replaceState(null, "", `#/${page}`);

  for (const [name, node] of Object.entries(pageEls)) {
    node.hidden = name !== page;
  }
  document.querySelectorAll(".nav a").forEach((link) => {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  if (page === "activity") loadActivity();
  if (page === "users") loadUsers();
}

window.addEventListener("hashchange", showPage);

// Refreshes the activity list only when someone is looking at it.
function refreshActivity() {
  if (currentPage() === "activity") loadActivity();
}

/* ---------- 7. Weather ---------- */
// Requests go through the authenticated backend so the API key is never exposed in the browser.
const getWeather = (city) => request(`/api/weather?city=${encodeURIComponent(city)}`);

const nowSec = () => Date.now() / 1000;

// Formats a UTC timestamp (seconds) shifted to the city's local time.
function clockFor(unixSeconds, offsetSeconds, options = {}) {
  return new Date((unixSeconds + offsetSeconds) * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    ...options
  });
}

// Maps OpenWeather's condition group to one of our hero colour themes.
function conditionKey(main = "") {
  const value = main.toLowerCase();
  if (value === "clear") return "clear";
  if (value === "clouds") return "clouds";
  if (value === "rain" || value === "drizzle") return "rain";
  if (value === "thunderstorm") return "storm";
  if (value === "snow") return "snow";
  return "mist"; // mist, fog, haze, smoke, dust, sand, ash, squall, tornado
}

function compass(degrees) {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(degrees / 22.5) % 16];
}

function showWeather(data) {
  currentWeather = data;
  currentCity = data.name;

  const { name, sys, weather, main, wind, clouds, visibility, timezone = 0 } = data;
  const condition = weather[0];

  resultEl.dataset.condition = conditionKey(condition.main);
  $("place").textContent = `${name}, ${sys.country}`;
  $("desc").textContent = condition.description;
  $("icon").src = `https://openweathermap.org/img/wn/${condition.icon}@2x.png`;
  $("icon").alt = condition.description;
  $("temp").textContent = Math.round(main.temp);
  $("feels").textContent = `${Math.round(main.feels_like)}°`;
  $("high").textContent = `${Math.round(main.temp_max)}°`;
  $("low").textContent = `${Math.round(main.temp_min)}°`;

  $("humidity").textContent = `${main.humidity}%`;
  $("wind").textContent = `${Math.round(wind.speed * 3.6)} km/h`;
  $("wind-dir").textContent = wind.deg != null ? `From the ${compass(wind.deg)}` : "";
  $("pressure").textContent = `${main.pressure} hPa`;
  $("visibility").textContent = visibility != null ? `${(visibility / 1000).toFixed(1)} km` : "—";
  $("clouds").textContent = clouds ? `${clouds.all}%` : "—";
  $("sunrise").textContent = sys.sunrise ? clockFor(sys.sunrise, timezone) : "—";
  $("sunset").textContent = sys.sunset ? clockFor(sys.sunset, timezone) : "—";

  setSaveMsg("");
  updateSaveButton();
  emptyEl.hidden = true;
  resultEl.hidden = false;

  updateClock();
  startClock();
}

// Updates the local date, time, and daylight bar. Runs every 30 seconds while a city is shown.
function updateClock() {
  if (!currentWeather) return;
  const { sys, timezone = 0 } = currentWeather;
  const now = nowSec();

  $("local-date").textContent = new Date((now + timezone) * 1000).toLocaleDateString([], {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC"
  });
  $("local-time").textContent = `${clockFor(now, timezone)} local time`;

  const { sunrise, sunset } = sys;
  const hasSun = Boolean(sunrise && sunset);
  resultEl.classList.toggle("is-night", hasSun && (now < sunrise || now > sunset));

  if (!hasSun) {
    $("daylight-fill").style.width = "0%";
    $("daylight-label").textContent = "Daylight times unavailable";
    return;
  }

  const share = Math.min(1, Math.max(0, (now - sunrise) / (sunset - sunrise)));
  $("daylight-fill").style.width = `${share * 100}%`;

  if (now < sunrise) {
    $("daylight-label").textContent = `Sunrise at ${clockFor(sunrise, timezone)}`;
  } else if (now > sunset) {
    $("daylight-label").textContent = `Sun set at ${clockFor(sunset, timezone)}`;
  } else {
    const left = sunset - now;
    const hours = Math.floor(left / 3600);
    const minutes = Math.floor((left % 3600) / 60);
    $("daylight-label").textContent = `${hours}h ${minutes}m of daylight left`;
  }
}

function startClock() {
  stopClock();
  clockTimer = setInterval(updateClock, 30000);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const city = cityInput.value.trim();
  if (!city) return;
  if (!store.get(TOKEN_KEY)) return leaveApp("Sign in to continue.");

  searchBtn.disabled = true;
  resultEl.hidden = true;
  emptyEl.hidden = true;
  setStatus("Loading…");
  try {
    showWeather(await getWeather(city));
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
    // Keep the previous result visible if there was one; otherwise show the empty state again.
    resultEl.hidden = !currentWeather;
    emptyEl.hidden = Boolean(currentWeather);
  } finally {
    searchBtn.disabled = false;
  }
});

/* ---------- 8. Saved cities ---------- */
const isSaved = (city) => saved.some((c) => c.city.toLowerCase() === city.toLowerCase());

function updateSaveButton() {
  const already = currentCity && isSaved(currentCity);
  saveBtn.disabled = !currentCity || already;
  saveBtn.textContent = already ? "Saved" : "Save this city";
}

function stopEditing() {
  editingId = null;
  renderSaved();
}

function renderSavedRow(city) {
  const li = el("li");
  const main = el("div", "saved__main");

  const name = el("button", "link", `📍 ${city.city}`);
  name.type = "button";
  name.title = `Show weather for ${city.city}`;
  name.addEventListener("click", () => {
    if (location.hash !== "#/dashboard") location.hash = "#/dashboard";
    cityInput.value = city.city;
    searchForm.requestSubmit();
  });
  main.append(name);

  if (editingId === city.id) {
    const input = el("input");
    input.type = "text";
    input.maxLength = 200;
    input.value = city.note;
    input.placeholder = "Add a note";
    input.setAttribute("aria-label", `Note for ${city.city}`);

    const commit = () => saveNote(city, input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") stopEditing();
    });

    const actions = el("div", "saved__actions");
    actions.append(actionButton("Save", "", commit), actionButton("Cancel", "", stopEditing));

    li.append(main, input, actions);
    setTimeout(() => input.focus(), 0);
  } else {
    const actions = el("div", "saved__actions");
    actions.append(
      actionButton("Edit", "", () => { editingId = city.id; renderSaved(); }),
      actionButton("Delete", "danger", () => removeCity(city))
    );
    main.append(actions);
    li.append(main);
    if (city.note) li.append(el("p", "saved__note", city.note));
  }
  return li;
}

function renderSaved() {
  savedList.replaceChildren(...saved.map(renderSavedRow));
  savedEmpty.hidden = saved.length > 0;
  savedCount.textContent = saved.length ? String(saved.length) : "";
  updateSaveButton();
}

async function loadSaved() {
  try {
    saved = await request("/api/cities");
    renderSaved();
  } catch (err) {
    savedEmpty.hidden = false;
    savedEmpty.textContent = err.message;
  }
}

saveBtn.addEventListener("click", async () => {
  if (!currentCity) return;
  saveBtn.disabled = true;
  try {
    await request("/api/cities", { method: "POST", body: { city: currentCity } });
    await loadSaved();
    setSaveMsg("Saved.", false);
    refreshActivity();
  } catch (err) {
    setSaveMsg(err.message);
    updateSaveButton();
  }
});

async function saveNote(city, note) {
  try {
    await request(`/api/cities/${city.id}`, { method: "PUT", body: { note } });
    editingId = null;
    await loadSaved();
    refreshActivity();
  } catch (err) {
    setSaveMsg(err.message);
  }
}

async function removeCity(city) {
  if (!confirm(`Delete ${city.city} from your saved cities?`)) return;
  try {
    await request(`/api/cities/${city.id}`, { method: "DELETE" });
    await loadSaved();
    refreshActivity();
  } catch (err) {
    setSaveMsg(err.message);
  }
}

/* ---------- 9. Activity log ---------- */
const quote = (value) => (value === "" ? "(empty)" : `"${value}"`);

function describe(entry) {
  const details = entry.details || {};

  if (entry.entity === "user") {
    if (details.change === "password") return "Changed their password";
    if (entry.action === "CREATE") {
      const role = details.role === "admin" ? " as administrator" : "";
      return `Created account ${details.username || ""}${role}`;
    }
    return `${entry.action} account ${details.username || ""}`;
  }

  const verb = { CREATE: "Saved", UPDATE: "Edited", DELETE: "Deleted" }[entry.action] || entry.action;
  let text = `${verb} ${details.city || "a city"}`;

  if (entry.action === "UPDATE" && details.changes) {
    const parts = Object.entries(details.changes)
      .map(([key, value]) => `${key} from ${quote(value.from)} to ${quote(value.to)}`);
    text += `: ${parts.join(", ")}`;
  } else if (entry.action === "CREATE" && details.note) {
    text += ` with note ${quote(details.note)}`;
  }
  return text;
}

async function loadActivity() {
  try {
    const rows = await request("/api/audit");
    activityList.replaceChildren();
    activityEmpty.hidden = rows.length > 0;
    activityEmpty.textContent = "No activity yet.";

    for (const entry of rows) {
      const when = el("time", "", new Date(entry.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
      when.dateTime = entry.at;
      const li = el("li");
      li.append(when, el("span", "", `${entry.user_email}: ${describe(entry)}`));
      activityList.append(li);
    }
  } catch (err) {
    activityEmpty.hidden = false;
    activityEmpty.textContent = err.message;
  }
}

/* ---------- 10. Account: change password ---------- */
passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = $("current-password").value;
  const newPassword = $("new-password").value;
  const confirmPassword = $("confirm-password").value;

  if (newPassword.length < 12) return setMessage(passwordStatus, "New password must be at least 12 characters.");
  if (newPassword !== confirmPassword) return setMessage(passwordStatus, "The new passwords do not match.");

  try {
    const result = await request("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
    passwordForm.reset();
    setMessage(passwordStatus, result.message, false);
    setTimeout(() => leaveApp("Password changed. Sign in with your new password."), 1200);
  } catch (err) {
    setMessage(passwordStatus, err.message);
  }
});

/* ---------- 11. Users (administrators only) ---------- */
createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    username: $("new-username").value.trim(),
    email: $("new-email").value.trim(),
    password: $("new-user-password").value,
    role: $("new-role").value
  };
  try {
    await request("/api/users", { method: "POST", body });
    createUserForm.reset();
    setMessage(adminStatus, "User created successfully.", false);
    await loadUsers();
  } catch (err) {
    setMessage(adminStatus, err.message);
  }
});

$("refresh-users").addEventListener("click", loadUsers);

async function deleteUser(user) {
  if (!confirm(`Delete user "${user.username}"? Their saved cities will also be deleted.`)) return;
  try {
    await request(`/api/users/${user.id}`, { method: "DELETE" });
    await loadUsers();
    setMessage(adminStatus, `Deleted ${user.username}.`, false);
  } catch (err) {
    setMessage(adminStatus, err.message);
  }
}

async function loadUsers() {
  try {
    const users = await request("/api/users");
    const currentId = getStoredUser()?.id;
    usersList.replaceChildren();

    for (const user of users) {
      const details = el("div", "user-row__details");
      const avatar = el("div", "avatar", user.username.charAt(0).toUpperCase());
      const text = el("div", "user-row__text");
      text.append(
        el("strong", "", user.username),
        el("span", "muted", user.email ? `${user.role} · ${user.email}` : user.role)
      );
      details.append(avatar, text);

      const actions = el("div", "saved__actions");
      if (user.id === currentId) actions.append(el("span", "pill", "You"));
      else actions.append(actionButton("Delete", "danger", () => deleteUser(user)));

      const li = el("li", "user-row");
      li.append(details, actions);
      usersList.append(li);
    }
  } catch (err) {
    setMessage(adminStatus, err.message);
  }
}

/* ---------- 12. Init ---------- */
// On page load, check the stored token with the server before showing the app.
(async function init() {
  loadSetupStatus();
  if (!store.get(TOKEN_KEY)) return;
  try {
    const user = await request("/auth/me");
    store.set(USER_KEY, JSON.stringify(user));
    enterApp(user);
  } catch {
    // request() clears an invalid session; keep the sign-in view visible.
    authView.hidden = false;
    appView.hidden = true;
  }
})();