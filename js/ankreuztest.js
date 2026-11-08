(function () {
  var configEl = document.getElementById("ankreuztest-config");
  var root = document.getElementById("ankreuztest-root");
  var histogram = document.getElementById("ankreuztest-histogram");
  if (!configEl || !root) return;

  var config = JSON.parse(configEl.textContent);
  var TOKEN_KEY = "ankreuztest-token";
  var BOOT_KEY = "ankreuztest-bootstrap";
  var labelClass = "f6 b db mb1 mt3 sans-serif mid-gray";
  var inputClass = "w-100 f5 pv3 ph3 bg-light-gray bn";
  var buttonClass = "db mv2 white pa3 bn hover-shadow hover-bg-black bg-animate bg-black";
  var sitting = null;
  var finishing = false;
  var clockTimer = null;
  var saveTimer = null;
  var histogramRequest = 0;
  var questionCache = {};
  var previewing = {};
  var answerRev = 0;
  var navToken = 0;
  var navigating = false;

  function escapeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function post(body) {
    var lastError = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var response = await fetch(config.endpoint, {
          method: "POST",
          redirect: "follow",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(body)
        });
        var data = await response.json();
        if (data && data.retry && attempt < 2) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return data;
      } catch (error) {
        lastError = error;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastError || new Error("Verbindung fehlgeschlagen");
  }

  function blockHtml(fragment) {
    var text = String(fragment || "");
    if (text.trim().charAt(0) === "<") return text;
    return "<p>" + text + "</p>";
  }

  function applyFigures(container, figures) {
    (figures || []).forEach(function (figure) {
      var url = "data:" + figure.mediaType + ";base64," + figure.data;
      container.querySelectorAll("img").forEach(function (img) {
        var src = img.getAttribute("src") || "";
        if (src === figure.name || src.endsWith("/" + figure.name)) img.src = url;
      });
    });
  }

  function renderMath(container) {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false
    });
  }

  function prepareHtml(container) {
    if (sitting && sitting.question) applyFigures(container, sitting.question.figures);
    renderMath(container);
  }

  function remainingMs() {
    if (!sitting) return 0;
    return sitting.endsAt - (Date.now() + sitting.offset);
  }

  function formatClock(ms) {
    var safe = Math.max(0, ms);
    var total = Math.ceil(safe / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function warnBeforeLeave(event) {
    if (!sitting || sitting.done) return;
    event.preventDefault();
    event.returnValue = "";
  }

  function remember(data) {
    var offset = Date.parse(data.now) - Date.now();
    sitting = {
      token: data.token,
      endsAt: Date.parse(data.endsAt),
      offset: Number.isFinite(offset) ? offset : 0,
      index: data.index,
      total: data.total,
      question: data.question,
      answers: data.answers || {},
      done: false
    };
    sessionStorage.setItem(TOKEN_KEY, data.token);
    if (config.page === "sitting") window.addEventListener("beforeunload", warnBeforeLeave);
    questionCache = {};
    previewing = {};
    answerRev = 0;
    if (data.canPreview) sitting.canPreview = true;
    if (data.question) questionCache[data.index] = data.question;
  }

  function stash(data) {
    sessionStorage.setItem(TOKEN_KEY, data.token);
    try {
      sessionStorage.setItem(BOOT_KEY, JSON.stringify(data));
    } catch (error) {
      sessionStorage.removeItem(BOOT_KEY);
    }
  }

  function takeStash() {
    var raw = sessionStorage.getItem(BOOT_KEY);
    sessionStorage.removeItem(BOOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function showMessage(text) {
    root.innerHTML = '<p class="ankreuz-status">' + escapeText(text) + "</p>";
  }

  function showForm(error, values) {
    values = values || {};
    root.innerHTML =
      '<form id="ankreuz-form" class="black-80 sans-serif" novalidate>' +
        '<p class="serif mid-gray">Nach dem Start laufen ' + escapeText(config.durationText) + ". Prüfe die E-Mail-Adresse, bevor du startest.</p>" +
        (error ? '<p class="ankreuz-error">' + escapeText(error) + "</p>" : "") +
        '<label class="' + labelClass + '" for="ankreuz-first">Vorname</label>' +
        '<input class="' + inputClass + '" id="ankreuz-first" name="first" autocomplete="given-name" required value="' + escapeText(values.first || "") + '">' +
        '<label class="' + labelClass + '" for="ankreuz-last">Nachname</label>' +
        '<input class="' + inputClass + '" id="ankreuz-last" name="last" autocomplete="family-name" required value="' + escapeText(values.last || "") + '">' +
        '<label class="' + labelClass + '" for="ankreuz-email">E-Mail-Adresse</label>' +
        '<input class="' + inputClass + '" id="ankreuz-email" name="email" type="email" autocomplete="email" required value="' + escapeText(values.email || "") + '">' +
        '<label class="' + labelClass + '" for="ankreuz-email-again">E-Mail-Adresse wiederholen</label>' +
        '<input class="' + inputClass + '" id="ankreuz-email-again" name="emailAgain" type="email" autocomplete="email" required value="' + escapeText(values.again || "") + '">' +
        '<label class="ankreuz-check mt3 serif mid-gray" for="ankreuz-consent">' +
          '<input id="ankreuz-consent" type="checkbox" required' + (values.consent ? " checked" : "") + ">" +
          "<span>Ich bin einverstanden, dass Vorname, Nachname und E-Mail-Adresse gespeichert werden, um diese Runde durchzuführen und zur nächsten Runde einzuladen.</span>" +
        "</label>" +
        '<button class="' + buttonClass + ' w-100" type="submit">Test starten</button>' +
      "</form>";
    document.getElementById("ankreuz-form").addEventListener("submit", onStart);
  }

  async function onStart(event) {
    event.preventDefault();
    var first = document.getElementById("ankreuz-first").value.trim();
    var last = document.getElementById("ankreuz-last").value.trim();
    var email = document.getElementById("ankreuz-email").value.trim();
    var again = document.getElementById("ankreuz-email-again").value.trim();
    var consent = document.getElementById("ankreuz-consent").checked;
    var entered = { first: first, last: last, email: email, again: again, consent: consent };
    if (!first || !last) return showForm("Bitte trag Vor- und Nachnamen ein.", entered);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showForm("Bitte trag eine gültige E-Mail-Adresse ein.", entered);
    if (email.toLowerCase() !== again.toLowerCase()) return showForm("Die beiden E-Mail-Adressen stimmen nicht überein.", entered);
    if (!consent) return showForm("Bitte stimme der Speicherung von Name und E-Mail zu.", entered);
    var button = event.target.querySelector("button");
    button.disabled = true;
    try {
      var data = await post({
        action: "start",
        firstName: first,
        lastName: last,
        email: email,
        consent: true
      });
      if (data.done) return showResult(data);
      if (!data.ok) return showForm(data.message || "Der Test konnte nicht gestartet werden.", entered);
      if (config.sittingURL) {
        stash(data);
        window.location.assign(config.sittingURL);
        return;
      }
      remember(data);
      showQuestion();
    } catch (error) {
      showForm("Verbindung fehlgeschlagen. Bitte noch einmal versuchen.", entered);
    }
  }

  function selectedChoice() {
    if (!sitting || !sitting.question) return null;
    var value = sitting.answers[sitting.question.id];
    return value === undefined || value === null ? null : Number(value);
  }

  function showQuestion() {
    var question = sitting.question;
      var choices = question.choices.map(function (choice, index) {
      var checked = selectedChoice() === index ? " checked" : "";
      var selected = selectedChoice() === index ? " is-selected" : "";
      return '<label class="ankreuz-choice' + selected + '">' +
        '<input type="radio" name="choice" value="' + index + '"' + checked + ">" +
        "<div>" + blockHtml(choice) + "</div></label>";
    }).join("");
    root.innerHTML =
      '<div class="ankreuz-timer" role="timer" id="ankreuz-timer"></div>' +
      '<p class="sans-serif mid-gray">Frage ' + (sitting.index + 1) +
        " · " + question.points + (question.points === 1 ? " Punkt" : " Punkte") + "</p>" +
      '<div class="ankreuz-stem serif f4" id="ankreuz-stem">' + blockHtml(question.stem) + "</div>" +
      '<div id="ankreuz-choices">' + choices + "</div>" +
      '<p class="ankreuz-error" id="ankreuz-error" hidden></p>' +
      '<div class="ankreuz-actions">' +
        '<button type="button" class="' + buttonClass + ' ankreuz-secondary" id="ankreuz-prev"' + (sitting.index === 0 ? " disabled" : "") + ">Zurück</button>" +
        (sitting.index >= sitting.total - 1 ? "" : '<button type="button" class="' + buttonClass + '" id="ankreuz-next">Weiter</button>') +
        '<button type="button" class="' + buttonClass + '" id="ankreuz-end">Test beenden</button>' +
      "</div>";
    prepareHtml(root);
    tick();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(tick, 250);
    root.querySelectorAll('input[name="choice"]').forEach(function (input) {
      input.addEventListener("change", function () {
        sitting.answers[question.id] = Number(input.value);
        answerRev += 1;
        root.querySelectorAll(".ankreuz-choice").forEach(function (label) {
          label.classList.toggle("is-selected", label.contains(input) && input.checked);
        });
        scheduleSave();
      });
    });
    document.getElementById("ankreuz-prev").addEventListener("click", function () {
      goTo(sitting.index - 1);
    });
    var next = document.getElementById("ankreuz-next");
    if (next) next.addEventListener("click", function () {
      goTo(sitting.index + 1);
    });
    document.getElementById("ankreuz-end").addEventListener("click", askToFinish);
    prefetch(sitting.index + 1);
    prefetch(sitting.index - 1);
  }

  function askToFinish() {
    if (document.getElementById("ankreuz-confirm")) return;
    var dialog = document.createElement("div");
    dialog.id = "ankreuz-confirm";
    dialog.className = "ankreuz-confirm";
    dialog.innerHTML =
      '<div class="ankreuz-confirm__box" role="dialog" aria-modal="true" aria-labelledby="ankreuz-confirm-title">' +
        '<h2 class="f3 athelas mt0 mb2" id="ankreuz-confirm-title">Bist du dir sicher?</h2>' +
        '<p class="serif mid-gray mt0">Der Test wird damit abgegeben.</p>' +
        '<div class="ankreuz-actions">' +
          '<button type="button" class="' + buttonClass + '" id="ankreuz-confirm-yes">Ja</button>' +
          '<button type="button" class="' + buttonClass + ' ankreuz-secondary" id="ankreuz-confirm-no">Nein</button>' +
        "</div></div>";
    document.body.appendChild(dialog);
    function close() {
      dialog.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    document.getElementById("ankreuz-confirm-no").addEventListener("click", close);
    document.getElementById("ankreuz-confirm-yes").addEventListener("click", function () {
      close();
      finish();
    });
    document.getElementById("ankreuz-confirm-no").focus();
  }

  function tick() {
    var clock = document.getElementById("ankreuz-timer");
    if (!clock || !sitting) return;
    var left = remainingMs();
    clock.textContent = formatClock(left);
    clock.classList.toggle("is-late", left < 60000);
    if (left <= 0) finish();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveAnswers(); }, 300);
  }

  async function saveAnswers() {
    if (!sitting || sitting.done) return;
    var rev = answerRev;
    var answers = sitting.answers;
    try {
      await post({ action: "save", token: sitting.token, answers: answers, rev: rev });
    } catch (error) {
      var note = document.getElementById("ankreuz-error");
      if (note) {
        note.hidden = false;
        note.textContent = "Die letzte Antwort konnte nicht gespeichert werden.";
      }
    }
  }

  function prefetch(index) {
    if (!sitting || !sitting.canPreview || sitting.done) return;
    if (index < 0 || index >= sitting.total) return;
    if (questionCache[index] || previewing[index]) return;
    previewing[index] = true;
    post({ action: "question", token: sitting.token, index: index, preview: true }).then(function (data) {
      delete previewing[index];
      if (!sitting || sitting.done || !data) return;
      if (data.done) return showResult(data);
      if (data.ok && data.question) questionCache[index] = data.question;
    }).catch(function () {
      delete previewing[index];
    });
  }

  function applyLoaded(data) {
    if (data.canPreview) sitting.canPreview = true;
    if (data.endsAt) sitting.endsAt = Date.parse(data.endsAt);
    if (data.question) questionCache[data.index] = data.question;
  }

  async function goTo(index) {
    if (!sitting || index < 0 || index >= sitting.total || index === sitting.index || navigating) return;
    if (saveTimer) clearTimeout(saveTimer);
    var seq = ++navToken;
    if (sitting.canPreview && questionCache[index]) {
      sitting.index = index;
      sitting.question = questionCache[index];
      showQuestion();
      syncPosition(index, seq);
      return;
    }
    navigating = true;
    try {
      if (!sitting.canPreview) await saveAnswers();
      var body = { action: "question", token: sitting.token, index: index };
      if (sitting.canPreview) {
        answerRev += 1;
        body.answers = sitting.answers;
        body.rev = answerRev;
      }
      var data = await post(body);
      if (seq !== navToken || !sitting) return;
      if (data.done) return showResult(data);
      if (!data.ok) throw new Error(data.message || "Aufgabe nicht verfügbar");
      sitting.index = data.index;
      sitting.question = data.question;
      applyLoaded(data);
      showQuestion();
    } catch (error) {
      var note = document.getElementById("ankreuz-error");
      if (note && seq === navToken) {
        note.hidden = false;
        note.textContent = "Die Aufgabe konnte nicht geladen werden. Bitte noch einmal versuchen.";
      }
    } finally {
      navigating = false;
    }
  }

  function syncPosition(index, seq) {
    answerRev += 1;
    var rev = answerRev;
    post({
      action: "question",
      token: sitting.token,
      index: index,
      answers: sitting.answers,
      rev: rev
    }).then(function (data) {
      if (!sitting || !data) return;
      if (data.done) return showResult(data);
      if (seq !== navToken) return;
      if (!data.ok) throw new Error(data.message || "Aufgabe nicht verfügbar");
      applyLoaded(data);
    }).catch(function () {
      var note = document.getElementById("ankreuz-error");
      if (note && seq === navToken) {
        note.hidden = false;
        note.textContent = "Die Aufgabe konnte nicht gespeichert werden. Bitte noch einmal weiter oder zurück.";
      }
    });
  }

  async function finish() {
    if (!sitting || sitting.done || finishing) return;
    finishing = true;
    if (clockTimer) clearInterval(clockTimer);
    if (saveTimer) clearTimeout(saveTimer);
    try {
      var data = await post({ action: "submit", token: sitting.token, answers: sitting.answers });
      if (!data.ok) throw new Error(data.message || "Abgabe fehlgeschlagen");
      showResult(data);
    } catch (error) {
      finishing = false;
      var note = document.getElementById("ankreuz-error");
      if (note) {
        note.hidden = false;
        note.textContent = "Die Abgabe ist fehlgeschlagen. Bitte noch einmal versuchen.";
      }
      if (remainingMs() > 0) clockTimer = setInterval(tick, 250);
    }
  }

  function showResult(data) {
    sessionStorage.removeItem(BOOT_KEY);
    if (sitting) sitting.done = true;
    finishing = false;
    window.removeEventListener("beforeunload", warnBeforeLeave);
    if (clockTimer) clearInterval(clockTimer);
    if (config.page === "sitting" && config.homeURL) {
      window.location.replace(config.homeURL);
      return;
    }
    var html = String(config.resultHtml || "")
      .replaceAll("{{score}}", String(data.score))
      .replaceAll("{{rank}}", String(data.rank));
    root.innerHTML = '<h2 class="f2 athelas">Ergebnis</h2><div class="serif f4">' + html + "</div>";
    renderMath(root);
    pollHistogram();
  }

  function drawHistogram(data) {
    if (!histogram) return;
    var chart = histogram.querySelector(".ankreuz-hist__chart");
    var total = data.total || 0;
    chart.textContent = "";
    if (!total) {
      histogram.hidden = true;
      return;
    }
    histogram.hidden = false;
    var max = 1;
    data.bins.forEach(function (bin) { if (bin.count > max) max = bin.count; });
    data.bins.forEach(function (bin) {
      var column = document.createElement("div");
      column.className = "ankreuz-col";
      var bar = document.createElement("div");
      bar.className = "ankreuz-bar";
      bar.style.height = Math.max(2, Math.round((bin.count / max) * 140)) + "px";
      var label = document.createElement("div");
      label.textContent = bin.from === bin.to ? String(bin.from) : bin.from + "–" + bin.to;
      column.appendChild(bar);
      column.appendChild(label);
      chart.appendChild(column);
    });
  }

  async function pollHistogram() {
    if (!config.endpoint) return;
    var request = ++histogramRequest;
    try {
      var data = await post({ action: "histogram" });
      if (request !== histogramRequest) return;
      if (data && data.ok) drawHistogram(data);
    } catch (error) {
      /* Keep the last chart if the poll fails. */
    }
  }

  async function resume() {
    var token = sessionStorage.getItem(TOKEN_KEY);
    if (!token || !config.endpoint) return false;
    try {
      var data = await post({ action: "resume", token: token });
      if (!data.ok) {
        sessionStorage.removeItem(TOKEN_KEY);
        return false;
      }
      if (data.done) {
        sitting = { token: token, done: true };
        showResult(data);
        return true;
      }
      remember(data);
      if (config.page !== "sitting" && config.sittingURL) {
        window.location.assign(config.sittingURL);
        return true;
      }
      showQuestion();
      return true;
    } catch (error) {
      showMessage("Die laufende Teilnahme konnte nicht geladen werden. Bitte lade die Seite neu.");
      return true;
    }
  }

  async function bootSitting() {
    if (!config.homeURL) return;
    var stashed = takeStash();
    if (stashed && stashed.token && stashed.question && !stashed.done) {
      remember(stashed);
      showQuestion();
      return;
    }
    if (!config.endpoint || !sessionStorage.getItem(TOKEN_KEY)) {
      window.location.replace(config.homeURL);
      return;
    }
    showMessage("Die Aufgabe wird geladen.");
    if (!(await resume())) window.location.replace(config.homeURL);
  }

  async function boot() {
    if (config.page === "sitting") {
      await bootSitting();
      return;
    }
    pollHistogram();
    setInterval(pollHistogram, 60000);
    if (!config.endpoint) {
      showMessage("Der Ankreuztest kann momentan nicht gestartet werden. Schreib uns an astro-olympiad@outlook.com, falls das so bleibt.");
      return;
    }
    if (await resume()) return;
    showForm("");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
