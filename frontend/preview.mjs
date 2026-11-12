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
const sendButton = document.getElementById('send-message');
const chatStatus = document.getElementById('chat-status');
const replyPreview = document.getElementById('reply-preview');
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let reply;

function setReply(next) {
  reply?.button.setAttribute('aria-pressed', 'false');
  reply = next;
  replyPreview.hidden = !reply;
  if (reply) {
    reply.button.setAttribute('aria-pressed', 'true');
    document.getElementById('reply-author').textContent = '回复 '+reply.author;
    document.getElementById('reply-text').textContent = reply.text;
  }
}

for (const item of messages.querySelectorAll('[data-author]')) {
  const author = item.dataset.author;
  const text = item.querySelector('.bubble').textContent;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet reply-button';
  button.textContent = '回复';
  button.setAttribute('aria-label', '回复'+author);
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    setReply(reply?.button === button ? undefined : { author, text, button });
    chatStatus.textContent = '';
    messageInput.focus();
  });
  item.querySelector('.message-meta').append(' ', button);
}

document.getElementById('cancel-reply').addEventListener('click', () => {
  setReply(undefined);
  messageInput.focus();
});

messageInput.addEventListener('input', () => {
  sendButton.disabled = !messageInput.value.trim();
  chatStatus.textContent = '';
});

composer.addEventListener('submit', event => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  const item = document.createElement('li');
  item.className = 'message outgoing';
  const body = document.createElement('div');
  const meta = document.createElement('p');
  meta.className = 'message-meta';
  const time = document.createElement('time');
  time.dateTime = new Date().toISOString();
  time.textContent = clock.format(new Date(time.dateTime));
  meta.append('我 ', time);
  const bubble = document.createElement('p');
  bubble.className = 'bubble';
  bubble.textContent = message;
  body.append(meta);
  if (reply) {
    const quote = document.createElement('blockquote');
    quote.className = 'reply-quote';
    quote.textContent = reply.author+' · '+reply.text;
    body.append(quote);
  }
  body.append(bubble);
  item.append(body);
  messages.append(item);
  composer.reset();
  setReply(undefined);
  chatStatus.textContent = '已发送';
  messageInput.focus();
  sendButton.disabled = true;
  messages.scrollTop = messages.scrollHeight;
});
