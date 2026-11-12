const pages = ['home', 'chat', 'planner'];
const titles = { home: '同行 · 旅行规划', chat: '旅伴聊天 · 同行', planner: '旅行工作台 · 同行' };

function showPage() {
  const requested = location.hash.slice(1);
  const defaultPage = new URLSearchParams(location.search).has('api') ? 'planner' : 'home';
  const active = pages.includes(requested) ? requested : defaultPage;
  for (const page of pages) {
    document.getElementById(page+'-page').hidden = page !== active;
    const link = document.querySelector('[data-page-link="'+page+'"]');
    if (page === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = titles[active];
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', showPage);
showPage();

const composer = document.getElementById('chat-compose');
const messageInput = document.getElementById('chat-message');
const messages = document.getElementById('messages');

composer.addEventListener('submit', event => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  const item = document.createElement('li');
  item.className = 'message outgoing';
  const body = document.createElement('div');
  const meta = document.createElement('p');
  meta.className = 'message-meta';
  meta.textContent = '我';
  const bubble = document.createElement('p');
  bubble.className = 'bubble';
  bubble.textContent = message;
  body.append(meta, bubble);
  item.append(body);
  messages.append(item);
  composer.reset();
  messageInput.focus();
  messages.scrollTop = messages.scrollHeight;
});
