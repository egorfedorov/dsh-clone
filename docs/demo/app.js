(function () {
  "use strict";

  const form = document.getElementById("signin-form");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const submit = form ? form.querySelector(".btn--primary") : null;

  if (!form || !submit) return;

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (submit.dataset.busy === "true") return;

    if (!email.value.trim()) {
      email.focus();
      return;
    }

    if (!password.value) {
      password.focus();
      return;
    }

    const label = submit.textContent;
    submit.dataset.busy = "true";
    submit.textContent = "Signing in…";

    window.setTimeout(function () {
      submit.dataset.busy = "false";
      submit.textContent = label;
    }, 1100);
  });

  const google = form.querySelector(".btn--google");
  if (google) {
    google.addEventListener("click", function () {
      google.blur();
    });
  }
})();
