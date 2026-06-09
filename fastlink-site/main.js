/* FastLink site — small vanilla interactions. No framework, no build. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- year ---- */
  var yr = document.getElementById("yr");
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---- sticky nav shadow ---- */
  var nav = document.getElementById("nav");
  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 12);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---- mobile menu ---- */
  var burger = document.getElementById("burger");
  var menu = document.getElementById("mobileMenu");
  if (burger && menu) {
    burger.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      burger.setAttribute("aria-expanded", String(open));
      document.body.style.overflow = open ? "hidden" : "";
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        menu.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
  }

  /* ---- scroll reveal ---- */
  var revealEls = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---- hero: typewriter in the mock field ---- */
  var typed = document.getElementById("typed");
  if (typed && !reduceMotion) {
    var phrase = "fastlink-demo";
    var i = 0;
    function tick() {
      typed.textContent = phrase.slice(0, i);
      i = i >= phrase.length ? 0 : i + 1;
      setTimeout(tick, i === 0 ? 1600 : 130);
    }
    setTimeout(tick, 800);
  } else if (typed) {
    typed.textContent = "fastlink-demo";
  }

  /* ---- transcript: staggered line-in loop ---- */
  var transcript = document.getElementById("transcript");
  if (transcript && !reduceMotion && "IntersectionObserver" in window) {
    var lines = Array.prototype.slice.call(transcript.querySelectorAll(".tline"));
    var played = false;
    function play() {
      lines.forEach(function (ln) { ln.classList.remove("is-in"); });
      lines.forEach(function (ln, idx) {
        setTimeout(function () { ln.classList.add("is-in"); }, idx * 520);
      });
    }
    var tio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && !played) { played = true; play(); }
      });
    }, { threshold: 0.4 });
    tio.observe(transcript);
  } else if (transcript) {
    transcript.querySelectorAll(".tline").forEach(function (l) { l.classList.add("is-in"); });
  }

  /* ---- feature card pointer glow ---- */
  if (!reduceMotion) {
    document.querySelectorAll(".js-tilt").forEach(function (card) {
      card.addEventListener("pointermove", function (ev) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", ((ev.clientX - r.left) / r.width) * 100 + "%");
        card.style.setProperty("--my", ((ev.clientY - r.top) / r.height) * 100 + "%");
      });
    });
  }

  /* ---- consent demo segmented control ---- */
  document.querySelectorAll(".consent .seg").forEach(function (seg) {
    seg.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        seg.querySelectorAll("button").forEach(function (b) { b.classList.remove("on"); });
        btn.classList.add("on");
      });
    });
  });

  /* ---- "Add to Chrome" placeholder (web-store link TBD) ---- */
  var add = document.getElementById("addChrome");
  if (add) {
    add.addEventListener("click", function (e) {
      e.preventDefault();
      add.dataset.original = add.dataset.original || add.innerHTML;
      add.innerHTML = "Coming soon to the Chrome Web Store";
      setTimeout(function () { add.innerHTML = add.dataset.original; }, 2200);
    });
  }
})();
