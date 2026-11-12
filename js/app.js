// app.js - 入口、页面切换

const PAGES = ['record', 'voice', 'edit', 'library'];

const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const titleEl = document.getElementById('page-title');

export function showPage(name) {
  if (!PAGES.includes(name)) name = PAGES[0];

  pages.forEach((page) => {
    const active = page.id === `page-${name}`;
    page.classList.toggle('is-active', active);
    if (active) titleEl.textContent = page.dataset.title;
  });

  tabs.forEach((tab) => {
    const active = tab.dataset.target === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  history.replaceState(null, '', `#${name}`);
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => showPage(tab.dataset.target));
});

showPage(location.hash.slice(1));
