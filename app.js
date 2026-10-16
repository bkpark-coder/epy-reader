// 웹 서재 e-리더 — 멀티 포맷 파서 포함 메인 애플리케이션 로직
// 지원: .epub .txt .pdf .md .docx .hwp(.hwpx)

'use strict';

/* ═══════════════════════════════════════════════════════
   1. 상수 & 유틸리티
═══════════════════════════════════════════════════════ */

const LS = {
  LIBRARY: 'wsb_library',
  STATES:  'wsb_states',
  QUOTES:  'wsb_quotes',
  REVIEWS: 'wsb_reviews',
  THEME:   'wsb_theme',
};

const FORMAT_LABEL = {
  epub: 'EPUB', epub3: 'EPUB', txt: 'TXT',
  pdf:  'PDF',  md:   'MD',   docx: 'DOCX',
  hwp:  'HWP',  hwpx: 'HWPX',
};
const FORMAT_CSS = {
  epub: 'fmt-epub', epub3: 'fmt-epub', txt: 'fmt-txt',
  pdf:  'fmt-pdf',  md:   'fmt-md',   docx: 'fmt-docx',
  hwp:  'fmt-hwp',  hwpx: 'fmt-hwp',
};

const PDF_WORKER_SRC = 'lib/pdf.worker.min.js';

// 세션 중 로드된 책 캐시 (홈화면에서 즉시 재오픈용)
const BookCache = {};

const el    = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeBookId(name, size) {
  let h = 0x811c9dc5;
  const s = name + '\x00' + size;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
function stripTags(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function countChars(str) { return str.replace(/\s/g, '').length; }
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}

/* ═══════════════════════════════════════════════════════
   2. LocalStorage 상태 관리
═══════════════════════════════════════════════════════ */

const StateManager = {
  getLibrary() { return JSON.parse(localStorage.getItem(LS.LIBRARY) || '{}'); },
  upsertLibraryItem(item) {
    const lib = this.getLibrary();
    lib[item.id] = { ...(lib[item.id] || {}), ...item };
    localStorage.setItem(LS.LIBRARY, JSON.stringify(lib));
  },
  removeLibraryItem(id) {
    const lib = this.getLibrary(); delete lib[id];
    localStorage.setItem(LS.LIBRARY, JSON.stringify(lib));
  },
  getReadingState(bookId) {
    return JSON.parse(localStorage.getItem(LS.STATES) || '{}')[bookId] || null;
  },
  saveReadingState(bookId, state) {
    const all = JSON.parse(localStorage.getItem(LS.STATES) || '{}');
    all[bookId] = state;
    localStorage.setItem(LS.STATES, JSON.stringify(all));
  },
  getQuotes(bookId)  { return (JSON.parse(localStorage.getItem(LS.QUOTES)  || '{}')[bookId]) || []; },
  addQuote(bookId, quote) {
    const all = JSON.parse(localStorage.getItem(LS.QUOTES) || '{}');
    if (!all[bookId]) all[bookId] = [];
    all[bookId].unshift(quote);
    localStorage.setItem(LS.QUOTES, JSON.stringify(all));
  },
  deleteQuote(bookId, qid) {
    const all = JSON.parse(localStorage.getItem(LS.QUOTES) || '{}');
    if (all[bookId]) { all[bookId] = all[bookId].filter(q => q.id !== qid); }
    localStorage.setItem(LS.QUOTES, JSON.stringify(all));
  },
  getReview(bookId)  { return (JSON.parse(localStorage.getItem(LS.REVIEWS) || '{}')[bookId]) || { rating:0, text:'', completed:false }; },
  saveReview(bookId, review) {
    const all = JSON.parse(localStorage.getItem(LS.REVIEWS) || '{}');
    all[bookId] = review;
    localStorage.setItem(LS.REVIEWS, JSON.stringify(all));
  },
};

/* ═══════════════════════════════════════════════════════
   2-B. IndexedDB 파일 영구 스토리지
═══════════════════════════════════════════════════════ */

const LibraryDB = {
  _db: null,
  DB_NAME: 'EpyLibraryDB',
  STORE:   'books',

  init() {
    return new Promise(resolve => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE))
          db.createObjectStore(this.STORE, { keyPath: 'id' });
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror   = e => { console.warn('IDB 초기화 실패:', e.target.error); resolve(); };
    });
  },

  saveBook(id, file) {
    if (!this._db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(this.STORE, 'readwrite');
      const req = tx.objectStore(this.STORE).put({ id, fileBlob: file, name: file.name, savedAt: new Date().toISOString() });
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  },

  getBook(id) {
    if (!this._db) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).get(id);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  },

  deleteBook(id) {
    if (!this._db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(this.STORE, 'readwrite');
      const req = tx.objectStore(this.STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  },
};

/* ═══════════════════════════════════════════════════════
   3-A. ePub 파서
═══════════════════════════════════════════════════════ */

const EpubParser = {
  async parse(file) {
    if (typeof JSZip === 'undefined')
      throw new Error('JSZip 라이브러리가 로드되지 않았습니다. 인터넷 연결을 확인하세요.');
    const zip = await JSZip.loadAsync(file);
    const containerXml = await zip.file('META-INF/container.xml').async('text');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'text/xml');
    const rootfileEl = containerDoc.querySelector('rootfile') || containerDoc.getElementsByTagName('rootfile')[0];
    if (!rootfileEl) throw new Error('container.xml에서 rootfile을 찾을 수 없습니다.');
    const rootfilePath = rootfileEl.getAttribute('full-path');
    const rootDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';
    const opfXml = await zip.file(rootfilePath).async('text');
    const opfDoc = new DOMParser().parseFromString(opfXml, 'text/xml');
    const pkgEl = opfDoc.querySelector('package') || opfDoc.getElementsByTagName('package')[0];
    const version = pkgEl ? (pkgEl.getAttribute('version') || '2.0') : '2.0';
    const getMeta = (tag) => {
      const ns = 'http://purl.org/dc/elements/1.1/';
      const e = opfDoc.getElementsByTagNameNS(ns, tag)[0] || opfDoc.getElementsByTagName('dc:'+tag)[0] || opfDoc.getElementsByTagName(tag)[0];
      return e ? e.textContent.trim() : '';
    };
    const title = getMeta('title'), creator = getMeta('creator');
    const manifest = {};
    Array.from(opfDoc.getElementsByTagName('item')).forEach(e => {
      const id = e.getAttribute('id');
      if (id) manifest[id] = { href: decodeURIComponent(e.getAttribute('href')||''), mediaType: e.getAttribute('media-type')||'', properties: e.getAttribute('properties')||'' };
    });
    const spine = [];
    Array.from(opfDoc.getElementsByTagName('itemref')).forEach(e => {
      const ref = manifest[e.getAttribute('idref')];
      if (ref && ref.mediaType !== 'application/x-dtbncx+xml') {
        const fp = this._joinPath(rootDir, ref.href);
        if (!spine.includes(fp)) spine.push(fp);
      }
    });
    let tocEntries = [];
    if (version.startsWith('3')) {
      const navItem = Object.values(manifest).find(m => m.properties === 'nav');
      if (navItem) {
        try { tocEntries = this._parseNav3(await zip.file(this._joinPath(rootDir, navItem.href)).async('text'), spine, rootDir); }
        catch (e) { console.warn('EPUB3 nav:', e); }
      }
    }
    if (!tocEntries.length) {
      const ncxItem = Object.values(manifest).find(m => m.mediaType === 'application/x-dtbncx+xml');
      if (ncxItem) {
        try { tocEntries = this._parseNcx2(await zip.file(this._joinPath(rootDir, ncxItem.href)).async('text'), spine, rootDir); }
        catch (e) { console.warn('EPUB2 NCX:', e); }
      }
    }
    if (!tocEntries.length) tocEntries = spine.map((_,i) => ({ label:`Chapter ${i+1}`, chapterIndex:i, section:null }));
    const chapterContents = [], chapterTexts = [];
    for (let i = 0; i < spine.length; i++) {
      const raw = await this._readFile(zip, spine[i]);
      const san = await this._processChapter(zip, raw, spine[i], rootDir);
      chapterContents.push(san); chapterTexts.push(countChars(stripTags(san)));
    }
    return { title: title || file.name.replace(/\.epub3?$/i,''), creator, tocEntries, chapterContents, chapterTexts };
  },
  _parseNcx2(xml, spine, rootDir) {
    const doc = new DOMParser().parseFromString(xml,'text/xml');
    const entries = [];
    Array.from(doc.getElementsByTagName('navPoint')).forEach(np => {
      const srcEl = np.getElementsByTagName('content')[0], textEl = np.getElementsByTagName('text')[0];
      if (!srcEl||!textEl) return;
      const src = srcEl.getAttribute('src')||'', label = textEl.textContent.trim();
      if (!src||!label) return;
      const [href, section] = src.split('#');
      const fullPath = this._joinPath(rootDir, decodeURIComponent(href));
      const idx = spine.indexOf(fullPath);
      if (idx !== -1) entries.push({ label, chapterIndex:idx, section:section||null });
    });
    return entries;
  },
  _parseNav3(html, spine, rootDir) {
    const doc = new DOMParser().parseFromString(html,'text/html');
    const nav = doc.querySelector('nav[epub\\:type="toc"]') || doc.querySelector('[epub\\:type="toc"]') || doc.querySelector('nav');
    if (!nav) return [];
    const entries = [];
    Array.from(nav.querySelectorAll('a')).forEach(a => {
      const href = a.getAttribute('href')||'', label = a.textContent.trim();
      if (!href||!label) return;
      const [hrefPart, section] = href.split('#');
      const fullPath = this._joinPath(rootDir, decodeURIComponent(hrefPart));
      const idx = spine.indexOf(fullPath);
      if (idx !== -1) entries.push({ label, chapterIndex:idx, section:section||null });
    });
    return entries;
  },
  async _readFile(zip, path) {
    const f = zip.file(path) || zip.file(path.replace(/^\//,'')) || zip.file('/'+path);
    return f ? await f.async('text') : '<p>(챕터 파일을 찾을 수 없습니다)</p>';
  },
  async _processChapter(zip, html, chapterPath, rootDir) {
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<link[^>]*/gi,'');
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let body = bodyMatch ? bodyMatch[1] : html;
    const chapterDir = chapterPath.includes('/') ? chapterPath.substring(0, chapterPath.lastIndexOf('/')+1) : rootDir;
    const imgRe = /(<img[^>]+src=["'])([^"']+)(["'])/gi;
    const imgMime = { jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp' };
    const placeholders = {}, imgPromises = [];
    let m;
    while ((m = imgRe.exec(body)) !== null) {
      const [full,pre,src,post] = m;
      if (src.startsWith('data:')) continue;
      const key = `__IMG${imgPromises.length}__`;
      placeholders[key] = {pre,post,src,full};
      imgPromises.push((async (k,s) => {
        const imgPath = this._joinPath(chapterDir, decodeURIComponent(s));
        try {
          const b64 = await zip.file(imgPath)?.async('base64');
          const ext = s.split('.').pop().toLowerCase().split('?')[0];
          if (b64) placeholders[k].data64 = `data:${imgMime[ext]||'image/jpeg'};base64,${b64}`;
        } catch(_) {}
      })(key,src));
    }
    if (imgPromises.length) {
      await Promise.all(imgPromises);
      for (const [key,val] of Object.entries(placeholders))
        body = body.replace(val.full, val.data64 ? `${val.pre}${val.data64}${val.post}` : '');
    }
    return body;
  },
  _joinPath(base, href) {
    if (!href) return base;
    if (href.startsWith('/')||href.startsWith('http')) return href;
    return (base+href).replace(/[^/]+\/\.\.\//g,'').replace(/\.\//g,'');
  },
};

/* ═══════════════════════════════════════════════════════
   3-B. TXT 파서
═══════════════════════════════════════════════════════ */

const TxtParser = {
  CHAPTER_RE: /^(chapter|챕터|제\s*\d+\s*[장절화]|\d{1,3}[장절화]|[ivxlc]+[.)]\s|제\s*\d+\s*부|\d+\.\s+\S)/i,
  parse(text) {
    const paras = text.split(/\n{2,}/).map(p=>p.trim()).filter(Boolean);
    const chapters = []; let cur = { title:'시작', paras:[] };
    for (const p of paras) {
      if (this.CHAPTER_RE.test(p) && p.length < 120) {
        if (cur.paras.length) chapters.push(cur);
        cur = { title:p, paras:[] };
      } else cur.paras.push(p);
    }
    if (cur.paras.length) chapters.push(cur);
    if (chapters.length <= 1) {
      const all = chapters[0]?.paras || paras;
      return Array.from({length:Math.ceil(all.length/50)},(_,i) => ({ title:`Part ${i+1}`, paras:all.slice(i*50,(i+1)*50) }));
    }
    return chapters;
  },
  toHtml(ch) { return ch.paras.map(p=>`<p>${escHtml(p)}</p>`).join('\n'); },
};

/* ═══════════════════════════════════════════════════════
   3-C. PDF 파서 — 문서 객체 반환 (캔버스 렌더링용)
═══════════════════════════════════════════════════════ */

const PdfParser = {
  async parse(file, onProgress) {
    if (typeof pdfjsLib === 'undefined')
      throw new Error('PDF.js 라이브러리가 로드되지 않았습니다. 인터넷 연결을 확인하세요.');
    const arrayBuffer = await file.arrayBuffer();
    if (onProgress) onProgress(0,1);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    if (onProgress) onProgress(1,1);
    let tocEntries = [];
    try {
      const outline = await pdf.getOutline();
      if (outline?.length) tocEntries = await this._outlineToEntries(pdf, outline, 0);
    } catch(e) { console.warn('PDF 아웃라인:', e); }
    if (!tocEntries.length) {
      for (let p = 1; p <= totalPages; p += 10) {
        const end = Math.min(p+9,totalPages);
        tocEntries.push({ label: totalPages<=10?'본문':`${p}–${end}페이지`, pageNum:p, chapterIndex:p-1, section:null });
      }
    }
    return { title:file.name.replace(/\.pdf$/i,''), creator:'', pdf, totalPages, tocEntries, chapterContents:[], chapterTexts:[totalPages] };
  },
  async _outlineToEntries(pdf, items, depth) {
    if (depth>2) return [];
    const entries = [];
    for (const item of items.slice(0,200)) {
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        const pageNum = (dest&&dest[0]) ? await pdf.getPageIndex(dest[0])+1 : 1;
        entries.push({ label:item.title||`페이지 ${pageNum}`, pageNum, chapterIndex:pageNum-1, section:null });
        if (item.items?.length) entries.push(...await this._outlineToEntries(pdf, item.items, depth+1));
      } catch(_) {}
    }
    return entries;
  },
};

/* ═══════════════════════════════════════════════════════
   3-C2. PDF 뷰어 — 고해상도 캔버스 + 텍스트 레이어

   스케일 결정 우선순위:
   1. fitMode='width' → 뷰포트 너비에 맞춤 (기본값)
   2. fitMode='page'  → 뷰포트에 전체 페이지 맞춤
   3. fitMode='manual' → _manualZoom 값 사용

   양면 보기: _spreadMode=true 시 페이지를 2개씩 그룹화
═══════════════════════════════════════════════════════ */

const PdfViewer = {
  _pdf:          null,
  _totalPages:   0,
  _rendered:     new Set(),
  _observer:     null,
  _pageNaturalW: 595,   // 1.0 스케일에서의 페이지 폭(pt)
  _pageNaturalH: 842,
  _fitMode:      'width', // 'width' | 'page' | 'manual'
  _manualZoom:   1.0,
  _spreadMode:   false,

  /* 현재 조건에서의 렌더링 스케일 계산 */
  _getScale() {
    const bw     = el('bookWrapper');
    const usable = Math.max(200, (bw ? bw.clientWidth : window.innerWidth) - 48);
    const rcH    = el('readerControls')?.clientHeight || 0;

    // 플립 모드: 화면에 꽉 차게 (높이 기준 + 너비 제한)
    if (PageFlip.mode === 'flip') {
      const topOffset = 52 + 10 + rcH + 8; // floating toolbar + gap + controls + padding
      const availH = window.innerHeight - topOffset - 32;
      const pagesW = this._pageNaturalW * (this._spreadMode ? 2 : 1) + (this._spreadMode ? 6 : 0);
      return Math.max(0.3, Math.min(usable / pagesW, availH / this._pageNaturalH));
    }

    const pagesAcross = this._spreadMode ? 2 : 1;
    const pageW = this._pageNaturalW * pagesAcross + (this._spreadMode ? 6 : 0);

    if (this._fitMode === 'width') {
      return Math.max(0.4, usable / pageW);
    }
    if (this._fitMode === 'page') {
      const availH = window.innerHeight - 52 - rcH - 60;
      return Math.max(0.4, Math.min(usable / this._pageNaturalW, availH / this._pageNaturalH));
    }
    return Math.max(0.4, Math.min(2.0, this._manualZoom));
  },

  async init(pdf, totalPages, savedPage = 1) {
    this._pdf        = pdf;
    this._totalPages = totalPages;
    this._rendered.clear();
    if (this._observer) { this._observer.disconnect(); this._observer = null; }

    // 자연 크기 측정 (스케일=1)
    const fp   = await pdf.getPage(1);
    const vpNat = fp.getViewport({ scale: 1.0 });
    this._pageNaturalW = vpNat.width;
    this._pageNaturalH = vpNat.height;

    const scale  = this._getScale();
    const estVp  = fp.getViewport({ scale });
    const estH   = Math.round(estVp.height) + 48;
    const estW   = Math.round(estVp.width);

    const container = el('bookContent');
    container.innerHTML = '';
    container.classList.toggle('pdf-spread-mode', this._spreadMode);

    el('bookWrapper').classList.add('pdf-mode');
    el('progressText').style.display = 'none';
    el('pdfProgress').style.display  = 'flex';

    // 플립 모드: 단독 페이지 렌더링
    if (PageFlip.mode === 'flip') {
      el('zoomLevel').textContent = '맞춤';
      const container = el('bookContent');
      container.innerHTML = '';
      container.classList.remove('pdf-spread-mode');
      App.pdfCurPage = savedPage;
      UI.updatePdfProgress(savedPage, totalPages);
      await this._renderFlipPage(savedPage, null);
      return;
    }

    el('zoomLevel').textContent = Math.round(scale * 100) + '%';

    // 페이지 wrapper 생성
    const addWrapper = (p) => {
      const w = document.createElement('div');
      w.className = 'pdf-page-wrapper';
      w.dataset.page = p;
      w.style.minHeight = estH + 'px';
      if (this._spreadMode) w.style.width = estW + 'px';
      return w;
    };

    if (this._spreadMode) {
      // 1페이지는 단독, 이후 2페이지씩 묶음
      for (let p = 1; p <= totalPages; ) {
        const group = document.createElement('div');
        group.className = 'pdf-spread-group';
        if (p === 1) {
          group.appendChild(addWrapper(1)); p++;
        } else {
          group.appendChild(addWrapper(p));
          if (p + 1 <= totalPages) group.appendChild(addWrapper(p + 1));
          p += 2;
        }
        container.appendChild(group);
      }
    } else {
      for (let p = 1; p <= totalPages; p++) container.appendChild(addWrapper(p));
    }

    // 지연 렌더링
    this._observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const p = parseInt(entry.target.dataset.page);
        if (!isNaN(p) && !this._rendered.has(p)) this._renderPage(entry.target, p);
      });
    }, { rootMargin: '500px 0px 500px 0px', threshold: 0 });

    container.querySelectorAll('.pdf-page-wrapper').forEach(w => this._observer.observe(w));

    App.pdfCurPage = savedPage;
    UI.updatePdfProgress(savedPage, totalPages);

    requestAnimationFrame(() => {
      if (savedPage > 1) this.scrollToPage(savedPage, 'instant');
    });
  },

  async _renderPage(wrapper, pageNum) {
    this._rendered.add(pageNum);
    const scale = this._getScale();
    try {
      const page     = await this._pdf.getPage(pageNum);
      const dpr      = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(viewport.width  * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width  = viewport.width  + 'px';
      canvas.style.height = viewport.height + 'px';
      canvas.style.display = 'block';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const textLayerDiv = document.createElement('div');
      textLayerDiv.className    = 'textLayer';
      textLayerDiv.style.width  = viewport.width  + 'px';
      textLayerDiv.style.height = viewport.height + 'px';

      try {
        const tc = await page.getTextContent();
        await pdfjsLib.renderTextLayer({ textContentSource:tc, container:textLayerDiv, viewport, textDivs:[] }).promise;
      } catch(e) { console.warn(`텍스트레이어 p${pageNum}:`, e); }

      const canvasWrap = document.createElement('div');
      canvasWrap.className    = 'pdf-canvas-container';
      canvasWrap.style.width  = viewport.width  + 'px';
      canvasWrap.style.height = viewport.height + 'px';
      canvasWrap.appendChild(canvas);
      canvasWrap.appendChild(textLayerDiv);

      const pageLabel = document.createElement('div');
      pageLabel.className   = 'pdf-page-num';
      pageLabel.textContent = `${pageNum} / ${this._totalPages}`;

      const card = document.createElement('div');
      card.className = 'pdf-page-card';
      card.appendChild(pageLabel);
      card.appendChild(canvasWrap);

      wrapper.innerHTML    = '';
      wrapper.style.minHeight = '';
      wrapper.style.width  = '';
      wrapper.appendChild(card);

    } catch(e) {
      console.error(`p${pageNum} 렌더링 오류:`, e);
      wrapper.innerHTML = `<div class="pdf-page-card"><p class="pdf-render-error">⚠ 페이지 ${pageNum} 렌더링 실패</p></div>`;
    }
  },

  /* 스케일/모드 변경 시 전체 재렌더링 */
  async rerender() {
    if (!this._pdf) return;
    await this.init(this._pdf, this._totalPages, App.pdfCurPage || 1);
  },

  scrollToPage(pageNum, behavior = 'smooth') {
    const w = document.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
    if (!w) return;
    // 플로팅 툴바가 fixed이므로 getBoundingClientRect + scrollY로 정확한 위치 계산
    const tbBottom = document.querySelector('.toolbar')?.getBoundingClientRect().bottom || 70;
    const top = w.getBoundingClientRect().top + window.scrollY - tbBottom - 8;
    window.scrollTo({ top: Math.max(0, top), behavior });
  },

  async goToPrev() {
    const t = Math.max(1, App.pdfCurPage - 1);
    if (PageFlip.mode === 'flip') { if (t !== App.pdfCurPage) await this._renderFlipPage(t, 'prev'); return; }
    App.pdfCurPage = t; UI.updatePdfProgress(t, this._totalPages); this.scrollToPage(t);
  },
  async goToNext() {
    const t = Math.min(this._totalPages, App.pdfCurPage + 1);
    if (PageFlip.mode === 'flip') { if (t !== App.pdfCurPage) await this._renderFlipPage(t, 'next'); return; }
    App.pdfCurPage = t; UI.updatePdfProgress(t, this._totalPages); this.scrollToPage(t);
  },

  /* 플립 모드 전용 — 단독 페이지 교체 + 슬라이드 애니메이션 */
  async _renderFlipPage(pageNum, direction) {
    if (PageFlip._animating) return;
    PageFlip._animating = true;
    try {
      const container = el('bookContent');
      const oldWrapper = container.querySelector('.pdf-page-wrapper');

      // 현재 페이지 퇴장 애니메이션
      if (oldWrapper && direction) {
        oldWrapper.classList.add(`pdf-exit-${direction}`);
        await sleep(190);
        oldWrapper.remove();
      } else if (oldWrapper) {
        oldWrapper.remove();
      }

      // 새 페이지 래퍼 생성 & 렌더
      const wrapper = document.createElement('div');
      wrapper.className    = 'pdf-page-wrapper';
      wrapper.dataset.page = pageNum;
      container.appendChild(wrapper);

      await this._renderPage(wrapper, pageNum);

      // 진입 애니메이션
      if (direction) {
        wrapper.classList.add(`pdf-enter-${direction}`);
        await sleep(260);
        wrapper.classList.remove(`pdf-enter-${direction}`);
      }

      App.pdfCurPage = pageNum;
      UI.updatePdfProgress(pageNum, this._totalPages);
      Reader.persistState();
    } finally {
      PageFlip._animating = false;
    }
  },

  fitWidth()  { this._fitMode = 'width';  el('btnFitWidth')?.classList.add('rc-active'); el('btnFitPage')?.classList.remove('rc-active'); this.rerender(); },
  fitPage()   { this._fitMode = 'page';   el('btnFitPage')?.classList.add('rc-active');  el('btnFitWidth')?.classList.remove('rc-active'); this.rerender(); },
  zoomIn()  {
    const cur = this._getScale();
    this._fitMode = 'manual'; this._manualZoom = Math.min(2.0, cur + 0.15);
    el('btnFitWidth')?.classList.remove('rc-active'); el('btnFitPage')?.classList.remove('rc-active');
    this.rerender();
  },
  zoomOut() {
    const cur = this._getScale();
    this._fitMode = 'manual'; this._manualZoom = Math.max(0.4, cur - 0.15);
    el('btnFitWidth')?.classList.remove('rc-active'); el('btnFitPage')?.classList.remove('rc-active');
    this.rerender();
  },
  toggleSpread() {
    this._spreadMode = !this._spreadMode;
    el('btnSinglePage')?.classList.toggle('rc-active', !this._spreadMode);
    el('btnSpreadPage')?.classList.toggle('rc-active',  this._spreadMode);
    this.rerender();
  },

  destroy() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    this._pdf = null; this._totalPages = 0; this._rendered.clear();
    el('bookWrapper')?.classList.remove('pdf-mode');
  },
};

/* ═══════════════════════════════════════════════════════
   3-D. Markdown 파서 (marked.js)
═══════════════════════════════════════════════════════ */

const MdParser = {
  parse(text, filename) {
    if (typeof marked === 'undefined')
      throw new Error('marked.js 라이브러리가 로드되지 않았습니다. 인터넷 연결을 확인하세요.');
    const lines = text.split('\n');
    const chapters = []; let cur = { title: filename.replace(/\.md$/i,''), lines:[] };
    for (const line of lines) {
      if (/^#{1,2}\s+\S/.test(line)) {
        if (cur.lines.length) chapters.push(cur);
        cur = { title: line.replace(/^#+\s+/,'').trim(), lines:[line] };
      } else cur.lines.push(line);
    }
    if (cur.lines.length) chapters.push(cur);
    const tp = chapters.length > 1 ? chapters : [{ title:filename.replace(/\.md$/i,''), lines }];
    return {
      title: filename.replace(/\.md$/i,''), creator:'',
      tocEntries:      tp.map((c,i) => ({ label:c.title, chapterIndex:i, section:null })),
      chapterContents: tp.map(c => `<div class="md-content">${marked.parse(c.lines.join('\n'))}</div>`),
      chapterTexts:    tp.map(c => countChars(c.lines.join(''))),
    };
  },
};

/* ═══════════════════════════════════════════════════════
   3-E. DOCX 파서 (mammoth.js)
═══════════════════════════════════════════════════════ */

const DocxParser = {
  async parse(file) {
    if (typeof mammoth === 'undefined')
      throw new Error('mammoth.js 라이브러리가 로드되지 않았습니다. 인터넷 연결을 확인하세요.');
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    if (result.messages?.length) console.info('mammoth:', result.messages);
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = result.value;
    const chapters = []; let cur = { title:'본문', nodes:[] };
    for (const node of Array.from(tempDiv.childNodes)) {
      if (node.nodeType===Node.ELEMENT_NODE && /^H[123]$/i.test(node.tagName)) {
        if (cur.nodes.length) chapters.push(cur);
        cur = { title:node.textContent.trim(), nodes:[node.cloneNode(true)] };
      } else cur.nodes.push(node.cloneNode(true));
    }
    if (cur.nodes.length) chapters.push(cur);
    if (!chapters.length) chapters.push({ title:file.name.replace(/\.docx$/i,''), nodes:Array.from(tempDiv.childNodes) });
    const chapterContents = chapters.map(ch => { const d=document.createElement('div'); ch.nodes.forEach(n=>d.appendChild(n.cloneNode(true))); return d.innerHTML; });
    return {
      title:file.name.replace(/\.docx$/i,''), creator:'',
      tocEntries:     chapters.map((c,i) => ({ label:c.title, chapterIndex:i, section:null })),
      chapterContents,
      chapterTexts:   chapters.map(c => countChars(c.nodes.map(n=>n.textContent||'').join(''))),
    };
  },
};

/* ═══════════════════════════════════════════════════════
   3-F. HWP 파서 (HWPX ZIP 지원)
═══════════════════════════════════════════════════════ */

const HwpParser = {
  async parse(file) {
    const header = new Uint8Array(await file.slice(0,4).arrayBuffer());
    if (header[0]===0x50 && header[1]===0x4B) return await this._parseHwpx(file);
    throw new Error('HWP 바이너리 형식은 브라우저에서 직접 파싱이 어렵습니다.\n한글 프로그램에서 [파일 → 다른 이름으로 저장]을 선택해\nDOCX 또는 TXT 형식으로 변환 후 다시 업로드해 주세요.\n\n※ .hwpx 파일(HWPX 포맷)은 바로 지원됩니다.');
  },
  async _parseHwpx(file) {
    const zip = await JSZip.loadAsync(file);
    const sectionFiles = Object.keys(zip.files).filter(n=>/(?:Contents[\\/])?[Ss]ection\d+\.xml$/.test(n))
      .sort((a,b) => parseInt(a.match(/\d+/)?.[0]||0) - parseInt(b.match(/\d+/)?.[0]||0));
    let title = file.name.replace(/\.hwpx?$/i,'');
    try {
      const hf = zip.file('Contents/header.xml')||zip.file('header.xml');
      if (hf) { const h=new DOMParser().parseFromString(await hf.async('text'),'text/xml'); const t=h.querySelector('hh\\:title')||h.querySelector('title'); if(t?.textContent.trim()) title=t.textContent.trim(); }
    } catch(_) {}
    if (!sectionFiles.length) throw new Error('HWPX 섹션 파일을 찾을 수 없습니다.');
    const chapters = [];
    for (const sf of sectionFiles) { const text=this._extractText(await zip.file(sf).async('text')); if(text.trim()) chapters.push({title:`섹션 ${chapters.length+1}`,text}); }
    if (!chapters.length) throw new Error('HWPX에서 텍스트를 추출하지 못했습니다.');
    return {
      title, creator:'',
      tocEntries:      chapters.map((c,i)=>({label:c.title,chapterIndex:i,section:null})),
      chapterContents: chapters.map(c=>c.text.split(/\n+/).filter(l=>l.trim()).map(l=>`<p>${escHtml(l)}</p>`).join('\n')),
      chapterTexts:    chapters.map(c=>countChars(c.text)),
    };
  },
  _extractText(xml) {
    const doc = new DOMParser().parseFromString(xml,'text/xml');
    const paras = [...doc.getElementsByTagName('hp:p'),...doc.getElementsByTagName('hh:p'),...doc.getElementsByTagName('p')];
    if (paras.length) return paras.map(p=>p.textContent.trim()).filter(Boolean).join('\n');
    for (const tag of ['hp:t','hh:t','t']) { const ns=Array.from(doc.getElementsByTagName(tag)); if(ns.length) return ns.map(n=>n.textContent).join(''); }
    return doc.documentElement.textContent||'';
  },
};

/* ═══════════════════════════════════════════════════════
   4. 진행률 계산기 (비-PDF용)
═══════════════════════════════════════════════════════ */

const ProgressTracker = {
  buildCharData(counts) {
    const total=counts.reduce((a,b)=>a+b,0); const cumulative=[]; let acc=0;
    counts.forEach(c=>{cumulative.push(acc);acc+=c;}); return {counts,cumulative,total};
  },
  calculate(chapterIndex, frac, cd) {
    if (!cd||!cd.total) return 0;
    return ((cd.cumulative[chapterIndex]||0) + (cd.counts[chapterIndex]||0)*Math.max(0,Math.min(1,frac))) / cd.total;
  },
};

/* ═══════════════════════════════════════════════════════
   5. 텍스트 독자 컨트롤 (EPUB/TXT/MD/DOCX/HWP 전용)
═══════════════════════════════════════════════════════ */

const TextReader = {
  fontSize:   17,
  lineHeight: 1.95,
  marginH:    44,

  apply() {
    document.querySelectorAll('.chapter-body').forEach(b => {
      b.style.fontSize   = this.fontSize + 'px';
      b.style.lineHeight = this.lineHeight;
    });
    const bw = el('bookWrapper');
    if (bw && App.book?.format !== 'pdf') {
      bw.style.paddingLeft  = this.marginH + 'px';
      bw.style.paddingRight = this.marginH + 'px';
    }
    const fd = el('fontSizeDisp');
    if (fd) fd.textContent = this.fontSize + 'px';
  },
  fontInc()    { this.fontSize   = Math.min(28,this.fontSize+1);                                              this.apply(); },
  fontDec()    { this.fontSize   = Math.max(12,this.fontSize-1);                                              this.apply(); },
  lineInc()    { this.lineHeight = Math.round(Math.min(3.0,this.lineHeight+0.1)*10)/10;                       this.apply(); },
  lineDec()    { this.lineHeight = Math.round(Math.max(1.3,this.lineHeight-0.1)*10)/10;                       this.apply(); },
  marginInc()  { this.marginH   = Math.min(120,this.marginH+8);                                               this.apply(); },
  marginDec()  { this.marginH   = Math.max(8,  this.marginH-8);                                               this.apply(); },
  reset()      { this.fontSize=17; this.lineHeight=1.95; this.marginH=44;                                     this.apply(); },
};

/* ═══════════════════════════════════════════════════════
   5-B. 페이지 넘김 모드 컨트롤러
═══════════════════════════════════════════════════════ */

const PageFlip = {
  mode:       'flip',   // 'flip' | 'scroll'
  _immersive: false,
  _animating: false,

  init() {
    this.mode = localStorage.getItem('wsb_viewmode') || 'flip';
    this._applyModeUI();
  },

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    localStorage.setItem('wsb_viewmode', mode);
    this._applyModeUI();
    this._applyToCurrentBook();
  },

  _applyModeUI() {
    const isFlip = this.mode === 'flip';
    el('btnFlipMode')?.classList.toggle('vmt-active', isFlip);
    el('btnScrollMode')?.classList.toggle('vmt-active', !isFlip);
    document.body.classList.toggle('flip-mode', isFlip);
  },

  _applyToCurrentBook() {
    if (!App.book) return;
    if (App.book.format === 'pdf') {
      PdfViewer.rerender();
    } else {
      if (this.mode === 'flip') {
        Reader.renderCurrentChapter(App.curChapter, null);
      } else {
        const savedChapter = App.curChapter;
        Reader.renderAllChapters(App.book, null);
        requestAnimationFrame(() => {
          const target = document.querySelectorAll('.chapter-section')[savedChapter];
          if (target) {
            const tbBottom = document.querySelector('.toolbar')?.getBoundingClientRect().bottom || 70;
            const top = target.getBoundingClientRect().top + window.scrollY - tbBottom - 8;
            window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
          }
        });
      }
    }
  },

  /* 다음/이전 페이지 통합 진입점 */
  next() { this._flip('next'); },
  prev() { this._flip('prev'); },

  _flip(direction) {
    if (!App.book) return;

    /* ── 팝업 페이지네이터 ── */
    if (PopupPager.active) {
      direction === 'next' ? PopupPager.next() : PopupPager.prev();
      return;
    }

    /* ── 세로 스크롤 모드: 뷰포트 기준 이동 ── */
    if (this.mode === 'scroll') {
      if (App.book.format === 'pdf') {
        // PDF: 실제 페이지 엘리먼트 단위 이동
        direction === 'next' ? PdfViewer.goToNext() : PdfViewer.goToPrev();
      } else {
        // EPUB/TXT/MD: 화면 높이 88% 부드러운 스크롤 (12% 컨텍스트 유지)
        const vh = window.innerHeight * 0.88;
        window.scrollBy({ top: direction === 'next' ? vh : -vh, behavior: 'smooth' });
      }
      return;
    }

    /* ── 플립 모드: 챕터/페이지 교체 ── */
    if (this._animating) return;
    if (App.book.format === 'pdf') {
      direction === 'next' ? PdfViewer.goToNext() : PdfViewer.goToPrev();
    } else {
      const cur = App.curChapter;
      const max = App.book.chapterContents.length - 1;
      const next = direction === 'next' ? Math.min(cur + 1, max) : Math.max(cur - 1, 0);
      if (next === cur) return;
      Reader.goToChapter(next, null, direction);
    }
  },

  /* 몰입 모드 토글 (툴바/컨트롤 숨김) */
  toggleImmersive() {
    this._immersive = !this._immersive;
    document.body.classList.toggle('immersive', this._immersive);
  },
  exitImmersive() {
    this._immersive = false;
    document.body.classList.remove('immersive');
  },
};

/* ═══════════════════════════════════════════════════════
   5-C. 팝업 뷰어 컨트롤러
═══════════════════════════════════════════════════════ */

const PopupViewer = {
  isPopupMode() {
    return new URLSearchParams(location.search).get('popup') === '1';
  },
  getBookId() {
    return new URLSearchParams(location.search).get('bookId') || null;
  },
  open(bookId) {
    if (!bookId) return;
    const h = Math.round(window.screen.availHeight * 0.92);
    const l = Math.round((window.screen.width - 860) / 2);
    const features = [
      'width=860', `height=${h}`, 'top=30', `left=${l}`,
      'menubar=no', 'toolbar=no', 'location=no', 'status=no', 'resizable=yes',
    ].join(',');
    const url = `${location.pathname}?popup=1&bookId=${encodeURIComponent(bookId)}`;
    const win = window.open(url, 'epy-popup-viewer', features);
    if (!win || win.closed) {
      UI.showToast('팝업이 차단되었습니다. 브라우저 주소창에서 팝업 허용을 눌러주세요.', 4000);
    }
  },
};

/* ═══════════════════════════════════════════════════════
   5-D. 팝업 페이지네이터 (팝업 모드 전용 CSS 다단 페이징)
═══════════════════════════════════════════════════════ */

const PopupPager = {
  _page:  0,
  _total: 0,
  _pageH: 0,   // 한 페이지 높이 (= availH)

  get active() {
    return PopupViewer.isPopupMode() && !!App.book && App.book.format !== 'pdf';
  },

  setup(savedPage = 0) {
    if (!this.active) return;
    const wrapper = el('bookWrapper');
    const content = el('bookContent');
    if (!wrapper || !content) return;

    // 사용 가능한 높이 계산
    const tbBottom = document.querySelector('.toolbar')?.getBoundingClientRect().bottom || 70;
    const rcEl     = document.querySelector('.reader-controls');
    const rcH      = (rcEl && document.body.classList.contains('has-controls')) ? rcEl.offsetHeight : 0;
    const availH   = window.innerHeight - tbBottom - rcH - 16;

    wrapper.style.height        = availH + 'px';
    wrapper.style.overflow      = 'hidden';
    // 상하좌우 여백 직접 지정 (CSS 캐스케이드 무관하게 확실히 적용)
    wrapper.style.paddingTop    = '28px';
    wrapper.style.paddingBottom = '28px';
    wrapper.style.paddingLeft   = '48px';
    wrapper.style.paddingRight  = '48px';

    this._pageH = availH - 56;   // availH - (paddingTop 28 + paddingBottom 28)

    content.style.transition = 'opacity 0.15s ease';
    content.style.transform  = 'translateY(0)';

    requestAnimationFrame(() => {
      this._total = Math.max(1, Math.ceil(content.scrollHeight / this._pageH));
      this._page  = Math.max(0, Math.min(savedPage, this._total - 1));
      this._jump(false);
    });
  },

  _jump(fade = true) {
    const content = el('bookContent');
    if (!content) return;

    const targetY = this._page * this._pageH;

    if (fade) {
      content.style.opacity = '0';
      setTimeout(() => {
        content.style.transform = `translateY(-${targetY}px)`;
        content.style.opacity   = '1';
      }, 120);
    } else {
      content.style.transform = `translateY(-${targetY}px)`;
    }

    const progress = this._total > 1 ? this._page / (this._total - 1) : 1;
    UI.updateProgress(progress);
    const pt = el('progressText');
    if (pt) pt.textContent = `${this._page + 1} / ${this._total}`;
  },

  _render() { this._jump(false); },

  go(page) {
    if (!this.active) return;
    this._page = Math.max(0, Math.min(page, this._total - 1));
    this._jump(true);
    if (App.book) {
      const progress = this._total > 1 ? this._page / (this._total - 1) : 1;
      StateManager.saveReadingState(App.book.id, { popupPage: this._page, relPctg: progress });
      StateManager.upsertLibraryItem({ id: App.book.id, progress, lastRead: new Date().toISOString() });
    }
  },

  next() { this.go(this._page + 1); },
  prev() { this.go(this._page - 1); },
};

/* ═══════════════════════════════════════════════════════
   6. 앱 전역 상태
═══════════════════════════════════════════════════════ */

const App = {
  book:          null,
  charData:      null,
  curChapter:    0,
  selection:     { text:'', chapterTitle:'' },
  reviewRating:  0,
  pdfCurPage:    1,
  pdfTotalPages: 0,
  _scrollTimer:  null,
  _observer:     null,
};

/* ═══════════════════════════════════════════════════════
   7. UI 헬퍼
═══════════════════════════════════════════════════════ */

const UI = {
  setTheme(theme) {
    document.body.className = document.body.className.replace(/\btheme-\w+/g,'').trim() + ` theme-${theme}`;
    localStorage.setItem(LS.THEME, theme);
  },

  /* 비-PDF 진행률 */
  updateProgress(fraction) {
    if (App.book?.format === 'pdf') return;
    const pct = Math.min(100,Math.max(0,Math.round(fraction*100)));
    el('progressBar').style.width  = pct + '%';
    el('progressText').textContent = pct + '%';
  },

  /* PDF 전용 진행률 + 버튼 상태 */
  updatePdfProgress(curPage, totalPages) {
    const pct = totalPages>0 ? Math.round((curPage/totalPages)*100) : 0;
    el('progressBar').style.width = pct + '%';
    el('pdfPageInfo').textContent  = `P. ${curPage} / ${totalPages}`;
    el('pdfPctText').textContent   = `(${pct}%)`;
    el('btnPdfPrev').disabled      = curPage <= 1;
    el('btnPdfNext').disabled      = curPage >= totalPages;
  },

  setBookTitle(t) { el('bookTitle').textContent = t || '웹 서재'; },

  switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id===`tab-${name}`));
  },

  /* ─── 홈 화면 표시/숨김 ─── */
  showHome() {
    el('homeScreen').style.display    = '';
    el('bookWrapper').style.display   = 'none';
    el('readerControls').style.display = 'none';
    document.body.classList.remove('has-controls', 'reader-mode');
    el('progressText').style.display  = '';
    el('pdfProgress').style.display   = 'none';
    el('progressBar').style.width     = '0%';
    el('progressText').textContent    = '0%';
    this.setBookTitle('나의 서재');
    this.renderDashboardStats();
    this.renderRecentBooks();
    this.renderLibrary();
    this.switchTab('library');
  },

  /* ─── 독서 화면 표시 ─── */
  showReader(format) {
    el('homeScreen').style.display    = 'none';
    el('bookWrapper').style.display   = 'block';
    el('readerControls').style.display = 'flex';
    document.body.classList.add('has-controls', 'reader-mode');
    // 포맷별 컨트롤 전환
    const isPdf = format === 'pdf';
    el('pdfCtrl').style.display  = isPdf ? 'flex' : 'none';
    el('textCtrl').style.display = isPdf ? 'none' : 'flex';
    // PDF 진행률 표시 전환
    el('progressText').style.display = isPdf ? 'none' : '';
    el('pdfProgress').style.display  = isPdf ? 'flex' : 'none';
  },

  /* ─── 홈 대시보드 통계 칩 렌더링 ─── */
  renderDashboardStats() {
    const library   = StateManager.getLibrary();
    const items     = Object.values(library);
    const total     = items.length;
    const completed = items.filter(b => StateManager.getReview(b.id).completed).length;
    const reading   = items.filter(b => (b.progress || 0) > 0 && !StateManager.getReview(b.id).completed).length;
    const statsEl   = el('homeStats');
    if (!statsEl) return;
    if (total === 0) { statsEl.innerHTML = ''; return; }
    statsEl.innerHTML = [
      { value: total,     label: '총 도서' },
      { value: reading,   label: '읽는 중' },
      { value: completed, label: '완독' },
    ].map(s => `
      <div class="stat-chip">
        <span class="stat-chip-value">${s.value}</span>
        <span class="stat-chip-label">${s.label}</span>
      </div>`).join('');
  },

  setLoading(msg, sub = '') {
    el('homeScreen').style.display  = 'none';
    el('bookWrapper').style.display = 'block';
    document.body.classList.add('reader-mode');
    el('bookContent').innerHTML     = `<div class="loading">${msg}${sub?`<div class="loading-sub">${sub}</div>`:''}</div>`;
  },

  showFileError(filename, err) {
    el('homeScreen').style.display  = 'none';
    el('bookWrapper').style.display = 'block';
    document.body.classList.add('reader-mode');
    const lines = (err.message||String(err)).split('\n');
    el('bookContent').innerHTML = `
      <div class="reader-error">
        <div class="error-icon">&#9888;</div>
        <div class="error-title">${escHtml(filename)} 로드 실패</div>
        <div class="error-details">${lines.map(l=>`<p>${escHtml(l)}</p>`).join('')}</div>
        <button class="rc-btn" style="margin-top:16px" onclick="Reader.goHome()">&#8592; 서재로 돌아가기</button>
      </div>`;
    if (lines.length <= 2) this.showToast(`⚠ ${lines[0]}`);
  },

  /* ─── TOC ─── */
  renderToc(tocEntries) {
    const panel = el('tab-toc');
    if (!tocEntries?.length) { panel.innerHTML = '<div class="empty-state"><p>목차 정보가 없습니다.</p></div>'; return; }
    panel.innerHTML = tocEntries.map((t,i) => `
      <div class="toc-item" data-chapter="${t.chapterIndex}" data-section="${t.section||''}" data-toc="${i}">
        <span class="toc-label">${escHtml(t.label)}</span>
      </div>`).join('');
    panel.querySelectorAll('.toc-item').forEach(item =>
      item.addEventListener('click', () => Reader.goToChapter(parseInt(item.dataset.chapter), item.dataset.section||null))
    );
  },

  highlightTocItem(idx) {
    document.querySelectorAll('.toc-item').forEach(item => item.classList.toggle('active', parseInt(item.dataset.chapter)===idx));
    el('tab-toc').querySelector('.toc-item.active')?.scrollIntoView({ block:'nearest' });
  },

  /* ─── 홈 화면 최근 책 그리드 ─── */
  renderRecentBooks() {
    const library = StateManager.getLibrary();
    const items   = Object.values(library).sort((a,b) => new Date(b.lastRead||0)-new Date(a.lastRead||0)).slice(0,12);
    if (!items.length) { el('recentSection').style.display='none'; return; }
    el('recentSection').style.display = 'block';
    el('recentGrid').innerHTML = items.map(item => {
      const pct      = Math.round((item.progress||0)*100);
      const fmtCss   = FORMAT_CSS[item.format]  || '';
      const fmtLabel = FORMAT_LABEL[item.format] || '';
      return `
        <div class="recent-card" data-id="${item.id}">
          <div class="recent-card-actions">
            <button class="rc-act rc-act-popup"  data-id="${item.id}" title="별도 창으로 열기">&#10697;</button>
            <button class="rc-act rc-act-delete" data-id="${item.id}" title="삭제">&#128465;</button>
          </div>
          <div class="recent-card-fmt"><span class="format-badge ${fmtCss}">${fmtLabel}</span></div>
          <div class="recent-card-title">${escHtml(item.title||item.filename||'(제목 없음)')}</div>
          <div class="recent-card-author">${escHtml(item.author||'')}</div>
          <div class="recent-card-track"><div class="recent-card-fill" style="width:${pct}%"></div></div>
          <div class="recent-card-meta">${pct}% &middot; ${fmtDate(item.lastRead)}</div>
          <div class="recent-card-resume">&#9654; 이어 읽기</div>
        </div>`;
    }).join('');

    // 팝업으로 열기 버튼
    el('recentGrid').querySelectorAll('.rc-act-popup').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        PopupViewer.open(btn.dataset.id);
      });
    });

    // 삭제 버튼
    el('recentGrid').querySelectorAll('.rc-act-delete').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        delete BookCache[id];
        await LibraryDB.deleteBook(id).catch(() => {});
        StateManager.removeLibraryItem(id);
        if (App.book?.id === id) {
          Reader.goHome();
        } else {
          this.renderRecentBooks();
          this.renderDashboardStats();
          this.renderLibrary();
        }
      });
    });

    el('recentGrid').querySelectorAll('.recent-card').forEach(card => {
      card.addEventListener('click', async e => {
        if (e.target.closest('.recent-card-actions')) return;
        e.stopPropagation();
        const id = card.dataset.id;
        if (BookCache[id]) { Reader.openFromCache(id); return; }
        // IDB에서 파일 로드
        try {
          UI.setLoading('&#128366; 책을 불러오는 중...');
          const record = await LibraryDB.getBook(id);
          if (record?.fileBlob) {
            await Reader.loadFile(record.fileBlob);
          } else {
            UI.showHome();
            UI.showToast('저장된 파일이 없습니다. 파일을 드래그하여 다시 열어주세요.');
          }
        } catch (err) {
          console.warn('IDB 로드 실패:', err);
          UI.showHome();
          UI.showToast('파일을 불러오지 못했습니다. 다시 드래그해 주세요.');
        }
      });
      // 3D 틸트 마이크로 인터랙션
      card.addEventListener('mousemove', e => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width  - 0.5;
        const y = (e.clientY - r.top)  / r.height - 0.5;
        card.classList.remove('tilt-reset');
        card.style.transform = `perspective(700px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) scale(1.03)`;
      });
      card.addEventListener('mouseleave', () => {
        card.classList.add('tilt-reset');
        card.style.transform = '';
      });
    });
  },

  /* ─── 사이드바 라이브러리 ─── */
  renderLibrary() {
    const panel   = el('tab-library');
    const library = StateManager.getLibrary();
    const items   = Object.values(library).sort((a,b)=>new Date(b.lastRead||0)-new Date(a.lastRead||0));
    if (!items.length) { panel.innerHTML='<div class="empty-state"><p>&#128218; 읽은 책이 없습니다.</p><p>문서 파일을 드래그해 보세요.</p></div>'; return; }
    panel.innerHTML = items.map(item => {
      const review   = StateManager.getReview(item.id);
      const pct      = Math.round((item.progress||0)*100);
      const stars    = '★'.repeat(review.rating||0) + '☆'.repeat(5-(review.rating||0));
      const isActive = App.book?.id === item.id;
      const fmtLabel = FORMAT_LABEL[item.format]||'';
      const fmtCss   = FORMAT_CSS[item.format]  ||'';
      const inCache  = !!BookCache[item.id];
      return `
        <div class="library-item${isActive?' active':''}" data-id="${item.id}" title="${inCache?'클릭하여 이어 읽기':'파일을 다시 드래그하여 열기'}">
          <div class="lib-title">${escHtml(item.title||item.filename||'(제목 없음)')}${fmtLabel?`<span class="format-badge ${fmtCss}">${fmtLabel}</span>`:''}</div>
          <div class="lib-meta">${item.author?escHtml(item.author)+' &middot; ':''}${fmtDate(item.lastRead)}</div>
          <div class="lib-track"><div class="lib-track-fill" style="width:${pct}%"></div></div>
          <div class="lib-footer"><span class="lib-stars">${stars}</span><span>${review.completed?'<span class="lib-badge">완독</span>':pct+'%'}</span></div>
        </div>`;
    }).join('');
    panel.querySelectorAll('.library-item').forEach(item =>
      item.addEventListener('click', async () => {
        const id = item.dataset.id;
        if (BookCache[id]) { Reader.openFromCache(id); return; }
        try {
          UI.setLoading('&#128366; 책을 불러오는 중...');
          const record = await LibraryDB.getBook(id);
          if (record?.fileBlob) {
            await Reader.loadFile(record.fileBlob);
          } else {
            UI.showHome();
            this.showToast('파일을 드래그하거나 선택하면 이어 읽을 수 있습니다.');
          }
        } catch (err) {
          UI.showHome();
          this.showToast('파일을 불러오지 못했습니다. 다시 드래그해 주세요.');
        }
      })
    );
  },

  /* ─── 필사 패널 ─── */
  renderQuotes(bookId) {
    const panel  = el('tab-quotes');
    const quotes = StateManager.getQuotes(bookId);
    if (!quotes.length) { panel.innerHTML='<div class="empty-state"><p>&#9998; 필사한 문장이 없습니다.</p><p>본문을 드래그하여 저장하세요.</p></div>'; return; }
    panel.innerHTML = `<button class="quotes-export" id="btnExportQuotes">&#8681; 텍스트로 내보내기</button>`
      + quotes.map(q => `
        <div class="quote-card" data-id="${q.id}">
          <div class="quote-text">&ldquo;${escHtml(q.text)}&rdquo;</div>
          <div class="quote-meta"><span class="quote-chapter">${escHtml(q.chapterTitle||'')}</span><button class="quote-delete" data-id="${q.id}" title="삭제">&times;</button></div>
        </div>`).join('');
    panel.querySelectorAll('.quote-delete').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); StateManager.deleteQuote(bookId, btn.dataset.id); this.renderQuotes(bookId); })
    );
    el('btnExportQuotes')?.addEventListener('click', () => {
      const text = StateManager.getQuotes(bookId).map(q=>`"${q.text}"\n— ${q.chapterTitle}`).join('\n\n');
      Object.assign(document.createElement('a'), { href:URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})), download:`${App.book?.title||'quotes'}_필사.txt` }).click();
    });
  },

  /* ─── 서평 모달 ─── */
  openReviewModal(bookId) {
    if (!bookId) return;
    const rv = StateManager.getReview(bookId);
    el('modalBookTitle').textContent = App.book?.title||'';
    el('reviewText').value           = rv.text||'';
    el('completeCheck').checked      = rv.completed||false;
    this.setStarRating(rv.rating||0);
    el('reviewModal').style.display  = 'flex';
  },
  closeReviewModal() { el('reviewModal').style.display='none'; },
  setStarRating(n) {
    App.reviewRating = n;
    el('starRating').querySelectorAll('.star').forEach(s => s.classList.toggle('active', parseInt(s.dataset.value)<=n));
  },

  showToast(msg, dur = 2200) {
    const t = document.createElement('div');
    t.className='toast'; t.textContent=msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, dur);
  },
};

/* ═══════════════════════════════════════════════════════
   8. 리더 컨트롤러
═══════════════════════════════════════════════════════ */

const Reader = {

  async loadFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const SUPPORTED = ['epub','epub3','txt','pdf','md','docx','hwp','hwpx'];
    if (!SUPPORTED.includes(ext)) { UI.showToast(`지원하지 않는 형식: .${ext}`); return; }

    UI.setLoading('&#128366; 파일을 로딩하는 중...');

    try {
      let parsed;
      switch (ext) {
        case 'txt': {
          const chapters = TxtParser.parse(await file.text());
          parsed = {
            title:file.name.replace(/\.txt$/i,''), creator:'',
            tocEntries:      chapters.map((c,i)=>({label:c.title,chapterIndex:i,section:null})),
            chapterContents: chapters.map(c=>TxtParser.toHtml(c)),
            chapterTexts:    chapters.map(c=>countChars(c.paras.join(''))),
          };
          break;
        }
        case 'epub': case 'epub3':
          UI.setLoading('&#128366; ePub 파싱 중...');
          parsed = await EpubParser.parse(file);
          break;
        case 'pdf':
          UI.setLoading('&#128196; PDF 로드 중...');
          parsed = await PdfParser.parse(file, (cur,total) => {
            el('bookContent').innerHTML = `<div class="loading">&#128196; PDF 로드 중...<div class="loading-sub">${cur} / ${total}</div></div>`;
          });
          break;
        case 'md': parsed = MdParser.parse(await file.text(), file.name); break;
        case 'docx':
          UI.setLoading('&#128196; DOCX 변환 중...');
          parsed = await DocxParser.parse(file);
          break;
        case 'hwp': case 'hwpx':
          UI.setLoading('&#128196; HWP 파일 분석 중...');
          parsed = await HwpParser.parse(file);
          break;
      }

      const book = {
        id:              makeBookId(file.name, file.size),
        title:           parsed.title || file.name.replace(/\.[^.]+$/,''),
        author:          parsed.creator||'',
        filename:        file.name,
        format:          ext,
        tocEntries:      parsed.tocEntries,
        chapterContents: parsed.chapterContents,
        chapterTexts:    parsed.chapterTexts,
      };
      if (ext === 'pdf') { book.pdf=parsed.pdf; book.totalPages=parsed.totalPages; App.pdfTotalPages=parsed.totalPages; App.pdfCurPage=1; }

      App.book       = book;
      App.charData   = ProgressTracker.buildCharData(book.chapterTexts);
      App.curChapter = 0;
      BookCache[book.id] = book;
      LibraryDB.saveBook(book.id, file).catch(e => console.warn('IDB 저장 실패:', e));

      StateManager.upsertLibraryItem({ id:book.id, title:book.title, author:book.author, filename:book.filename, format:ext, lastRead:new Date().toISOString(), progress:0 });
      UI.setBookTitle(book.title);
      UI.renderToc(book.tocEntries);
      UI.showReader(ext);      // ← 여기서 homeScreen 숨기고 독서 화면 표시
      UI.renderLibrary();

      if (ext === 'pdf') {
        const saved = StateManager.getReadingState(book.id);
        const savedPage = saved?.pdfPage || 1;
        App.pdfCurPage = savedPage;
        // fitWidth 모드 버튼 초기화
        el('btnFitWidth')?.classList.add('rc-active');
        el('btnFitPage')?.classList.remove('rc-active');
        el('btnSinglePage')?.classList.add('rc-active');
        el('btnSpreadPage')?.classList.remove('rc-active');
        PdfViewer._fitMode    = 'width';
        PdfViewer._spreadMode = false;
        await PdfViewer.init(book.pdf, book.totalPages, savedPage);
      } else {
        TextReader.reset();
        const saved = StateManager.getReadingState(book.id);
        if (!PopupViewer.isPopupMode() && PageFlip.mode === 'flip') {
          const startChapter = saved?.chapterIndex || 0;
          App.curChapter = startChapter;
          this.renderCurrentChapter(startChapter, null);
        } else {
          this.renderAllChapters(book, saved);
        }
      }

    } catch (err) {
      console.error(err);
      UI.showFileError(file.name, err);
    }
  },

  /* ─── 서재 홈으로 복귀 ─── */
  goHome() {
    PageFlip.exitImmersive();
    if (App.book) this.persistState();
    clearTimeout(App._scrollTimer);
    if (App._observer) { App._observer.disconnect(); App._observer=null; }
    PdfViewer.destroy();

    App.book=null; App.curChapter=0; App.pdfCurPage=1; App.pdfTotalPages=0;
    el('bookContent').innerHTML = '';

    // 팝업 모드: 서재 홈 대신 창 닫기
    if (PopupViewer.isPopupMode()) { window.close(); return; }

    UI.showHome();
  },

  /* ─── 캐시에서 즉시 재오픈 ─── */
  openFromCache(id) {
    const book = BookCache[id];
    if (!book) return;
    if (App.book?.id === id) { UI.showReader(book.format); return; }

    if (App.book) this.persistState();
    App.book       = book;
    App.charData   = ProgressTracker.buildCharData(book.chapterTexts);
    App.curChapter = 0;

    UI.setBookTitle(book.title);
    UI.renderToc(book.tocEntries);
    UI.showReader(book.format);
    UI.switchTab('toc');

    const saved = StateManager.getReadingState(book.id);
    if (book.format === 'pdf') {
      const savedPage = saved?.pdfPage || 1;
      App.pdfCurPage = savedPage; App.pdfTotalPages = book.totalPages;
      PdfViewer._fitMode = 'width'; PdfViewer._spreadMode = false;
      el('btnFitWidth')?.classList.add('rc-active');
      el('btnSinglePage')?.classList.add('rc-active');
      el('btnSpreadPage')?.classList.remove('rc-active');
      PdfViewer.init(book.pdf, book.totalPages, savedPage);
    } else {
      TextReader.reset();
      if (!PopupViewer.isPopupMode() && PageFlip.mode === 'flip') {
        const startChapter = saved?.chapterIndex || 0;
        App.curChapter = startChapter;
        this.renderCurrentChapter(startChapter, null);
      } else {
        this.renderAllChapters(book, saved);
      }
    }
    StateManager.upsertLibraryItem({ id:book.id, lastRead:new Date().toISOString() });
    UI.renderLibrary();
  },

  renderAllChapters(book, savedState) {
    const container = el('bookContent');
    container.innerHTML = '';
    book.chapterContents.forEach((html, i) => {
      const section = document.createElement('section');
      section.className = 'chapter-section';
      section.dataset.chapterIndex = i;
      const tocEntry = book.tocEntries.find(t=>t.chapterIndex===i);
      if (tocEntry) { const h=document.createElement('div'); h.className='chapter-header'; h.textContent=tocEntry.label; section.appendChild(h); }
      const body = document.createElement('div');
      body.className='chapter-body'; body.innerHTML=html;
      body.querySelectorAll('a[href]').forEach(a => { const href=a.getAttribute('href'); if(href&&!href.startsWith('#')){a.removeAttribute('href');a.style.cursor='default';} });
      section.appendChild(body);
      if (i < book.chapterContents.length-1) { const hr=document.createElement('div'); hr.className='chapter-divider'; hr.textContent='* * *'; section.appendChild(hr); }
      container.appendChild(section);
    });
    // 팝업 모드: IntersectionObserver 불필요 (스크롤 없음)
    if (!PopupViewer.isPopupMode()) this._setupObserver();

    requestAnimationFrame(() => {
      TextReader.apply();
      // 팝업 모드: CSS 다단 페이지네이터로 위임
      if (PopupViewer.isPopupMode()) {
        const savedPage = savedState?.popupPage || 0;
        PopupPager.setup(savedPage);
        return;
      }
      if (savedState) {
        const sections = document.querySelectorAll('.chapter-section');
        const target   = sections[savedState.chapterIndex];
        if (target) {
          window.scrollTo({ top: target.offsetTop + target.offsetHeight*(savedState.chapterScrollFraction||0), behavior:'instant' });
          App.curChapter = savedState.chapterIndex;
          UI.highlightTocItem(savedState.chapterIndex);
          UI.updateProgress(savedState.relPctg||0);
        }
      }
    });
  },

  _setupObserver() {
    if (App._observer) App._observer.disconnect();
    App._observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const idx = parseInt(entry.target.dataset.chapterIndex);
          if (!isNaN(idx) && idx !== App.curChapter) { App.curChapter=idx; UI.highlightTocItem(idx); }
        }
      });
    }, { rootMargin:'-20% 0px -70% 0px', threshold:0 });
    document.querySelectorAll('.chapter-section').forEach(s=>App._observer.observe(s));
  },

  /* ─── 플립 모드: 단일 챕터 렌더링 ─── */
  renderCurrentChapter(chapterIndex, direction) {
    const book = App.book;
    if (!book || chapterIndex === undefined || chapterIndex === null) return;

    const container = el('bookContent');
    const section   = document.createElement('section');
    section.className = 'chapter-section';
    section.dataset.chapterIndex = chapterIndex;

    const tocEntry = book.tocEntries.find(t => t.chapterIndex === chapterIndex);
    if (tocEntry) {
      const h = document.createElement('div');
      h.className   = 'chapter-header';
      h.textContent = tocEntry.label;
      section.appendChild(h);
    }
    const body = document.createElement('div');
    body.className = 'chapter-body';
    body.innerHTML = book.chapterContents[chapterIndex];
    body.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('#')) { a.removeAttribute('href'); a.style.cursor='default'; }
    });
    section.appendChild(body);

    if (direction) section.classList.add(`page-enter-${direction}`);
    container.innerHTML = '';
    container.appendChild(section);

    App.curChapter = chapterIndex;
    TextReader.apply();
    UI.highlightTocItem(chapterIndex);
    window.scrollTo({ top: 0, behavior: 'instant' });

    // 진행률 & 상태 저장
    if (App.charData?.total) {
      const pct = (App.charData.cumulative[chapterIndex] || 0) / App.charData.total;
      UI.updateProgress(pct);
      StateManager.saveReadingState(book.id, {
        chapterIndex, chapterScrollFraction: 0, relPctg: pct,
      });
      StateManager.upsertLibraryItem({ id: book.id, progress: pct, lastRead: new Date().toISOString() });
    }
  },

  goToChapter(chapterIndex, section, direction) {
    if (App.book?.format === 'pdf') { PdfViewer.scrollToPage(chapterIndex+1); return; }

    // 플립 모드: 단독 챕터 교체
    if (PageFlip.mode === 'flip' && !section) {
      this.renderCurrentChapter(chapterIndex, direction || 'next');
      return;
    }

    const target = document.querySelectorAll('.chapter-section')[chapterIndex];
    if (!target) return;
    if (section) {
      const anc = target.querySelector(`[id="${section}"]`) || target.querySelector(`[name="${section}"]`);
      if (anc) { anc.scrollIntoView({behavior:'smooth'}); return; }
    }
    target.scrollIntoView({behavior:'smooth'});
  },

  getChapterScrollFraction() {
    const s = document.querySelectorAll('.chapter-section')[App.curChapter];
    return s ? Math.max(0,Math.min(1,(window.scrollY-s.offsetTop)/Math.max(1,s.offsetHeight))) : 0;
  },

  getCurrentChapterTitle() {
    if (!App.book) return '';
    if (App.book.format === 'pdf') return `페이지 ${App.pdfCurPage}`;
    return App.book.tocEntries.find(t=>t.chapterIndex===App.curChapter)?.label || `Chapter ${App.curChapter+1}`;
  },

  persistState() {
    if (!App.book) return;
    if (PopupPager.active) return; // PopupPager가 go()마다 직접 저장
    if (App.book.format === 'pdf') {
      const progress = App.pdfTotalPages>0 ? App.pdfCurPage/App.pdfTotalPages : 0;
      StateManager.saveReadingState(App.book.id, { pdfPage:App.pdfCurPage });
      StateManager.upsertLibraryItem({ id:App.book.id, progress, lastRead:new Date().toISOString() });
      return;
    }
    const fraction = this.getChapterScrollFraction();
    const progress = ProgressTracker.calculate(App.curChapter, fraction, App.charData);
    StateManager.saveReadingState(App.book.id, { chapterIndex:App.curChapter, chapterScrollFraction:fraction, relPctg:progress });
    StateManager.upsertLibraryItem({ id:App.book.id, progress, lastRead:new Date().toISOString() });
    UI.updateProgress(progress);
    UI.renderLibrary();
  },
};

/* ═══════════════════════════════════════════════════════
   9. 전체화면 유틸
═══════════════════════════════════════════════════════ */

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(()=>{});
  } else {
    document.exitFullscreen?.();
  }
}

/* ═══════════════════════════════════════════════════════
   10. 이벤트 핸들러 초기화
═══════════════════════════════════════════════════════ */

function initEvents() {

  /* ─── 드래그 앤 드롭 ─── */
  const dropZone = el('dropZone');
  document.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  document.addEventListener('dragleave', e => { if (!document.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
  document.addEventListener('drop', async e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0]; if (file) await Reader.loadFile(file);
  });
  dropZone.addEventListener('click', () => el('fileInput').click());
  el('fileInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (file) await Reader.loadFile(file); e.target.value='';
  });

  /* ─── 서재 홈 버튼 ─── */
  el('btnHome').addEventListener('click', () => Reader.goHome());

  /* ─── 사이드바 ─── */
  el('btnSidebar').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    // 사이드바 개폐 시 PDF 너비 맞춤 재계산
    if (App.book?.format === 'pdf' && PdfViewer._fitMode !== 'manual') {
      setTimeout(() => PdfViewer.rerender(), 300);
    }
  });

  /* ─── 탭 전환 ─── */
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => { UI.switchTab(btn.dataset.tab); if (btn.dataset.tab==='quotes'&&App.book) UI.renderQuotes(App.book.id); })
  );

  /* ─── 테마 전환 ─── */
  document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => UI.setTheme(btn.dataset.theme)));

  /* ─── PDF 페이지 이동 ─── */
  el('btnPdfPrev').addEventListener('click', () => PdfViewer.goToPrev());
  el('btnPdfNext').addEventListener('click', () => PdfViewer.goToNext());

  /* ─── PDF 뷰어 컨트롤 ─── */
  el('btnFitWidth').addEventListener('click',   () => PdfViewer.fitWidth());
  el('btnFitPage').addEventListener('click',    () => PdfViewer.fitPage());
  el('btnZoomOut').addEventListener('click',    () => PdfViewer.zoomOut());
  el('btnZoomIn').addEventListener('click',     () => PdfViewer.zoomIn());
  el('btnSinglePage').addEventListener('click', () => { if (PdfViewer._spreadMode)  PdfViewer.toggleSpread(); });
  el('btnSpreadPage').addEventListener('click', () => { if (!PdfViewer._spreadMode) PdfViewer.toggleSpread(); });

  /* ─── 텍스트 컨트롤 (EPUB/TXT/MD) ─── */
  el('btnFontDec').addEventListener('click',   () => TextReader.fontDec());
  el('btnFontInc').addEventListener('click',   () => TextReader.fontInc());
  el('btnLineDec').addEventListener('click',   () => TextReader.lineDec());
  el('btnLineInc').addEventListener('click',   () => TextReader.lineInc());
  el('btnMarginDec').addEventListener('click', () => TextReader.marginDec());
  el('btnMarginInc').addEventListener('click', () => TextReader.marginInc());

  /* ─── 전체화면 ─── */
  el('btnFullscreen').addEventListener('click', () => toggleFullscreen());
  document.addEventListener('fullscreenchange', () => {
    const isFS = !!document.fullscreenElement;
    el('btnFullscreen').classList.toggle('rc-active', isFS);
    el('btnFullscreen').title = isFS ? '전체화면 종료' : '전체화면 (F)';
  });

  /* ─── 윈도우 리사이즈 시 PDF 너비 재계산 ─── */
  window.addEventListener('resize', () => {
    if (App.book?.format==='pdf' && PdfViewer._fitMode !== 'manual') {
      clearTimeout(App._scrollTimer);
      App._scrollTimer = setTimeout(() => PdfViewer.rerender(), 400);
    }
  });

  /* ─── 스크롤: 비-PDF 진행률 + PDF 현재 페이지 추적 ─── */
  window.addEventListener('scroll', () => {
    if (!App.book) return;
    if (App.book.format === 'pdf') {
      for (const w of document.querySelectorAll('.pdf-page-wrapper')) {
        if (w.getBoundingClientRect().bottom > 60) {
          const p = parseInt(w.dataset.page);
          if (!isNaN(p) && p !== App.pdfCurPage) {
            App.pdfCurPage = p;
            UI.updatePdfProgress(p, PdfViewer._totalPages);
            clearTimeout(App._scrollTimer);
            App._scrollTimer = setTimeout(() => Reader.persistState(), 800);
          }
          break;
        }
      }
      return;
    }
    const progress = ProgressTracker.calculate(App.curChapter, Reader.getChapterScrollFraction(), App.charData);
    UI.updateProgress(progress);
    clearTimeout(App._scrollTimer);
    App._scrollTimer = setTimeout(() => Reader.persistState(), 500);
  }, { passive:true });

  /* ─── 텍스트 선택 → 필사 툴팁 ─── */
  const tooltip = el('quoteTooltip');
  document.addEventListener('mouseup', () => {
    const sel  = window.getSelection();
    const text = sel?.toString().trim()||'';
    if (text.length>=6 && text.length<=600 && el('bookContent').contains(sel.anchorNode)) {
      App.selection = { text, chapterTitle:Reader.getCurrentChapterTitle() };
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      tooltip.style.display = 'block';
      tooltip.style.left    = Math.max(8, Math.min(rect.left+rect.width/2-70, window.innerWidth-160)) + 'px';
      tooltip.style.top     = (rect.top+window.scrollY-54) + 'px';
    } else { tooltip.style.display='none'; }
  });
  document.addEventListener('mousedown', e => { if (!tooltip.contains(e.target)) tooltip.style.display='none'; });

  /* ─── 필사 저장 ─── */
  el('btnSaveQuote').addEventListener('click', () => {
    if (!App.book||!App.selection.text) return;
    StateManager.addQuote(App.book.id, { id:Date.now().toString(36), text:App.selection.text, chapterTitle:App.selection.chapterTitle, savedAt:new Date().toISOString() });
    tooltip.style.display='none';
    window.getSelection()?.removeAllRanges();
    UI.switchTab('quotes'); UI.renderQuotes(App.book.id);
    UI.showToast('필사가 저장되었습니다 ✏');
  });

  /* ─── 서평 모달 ─── */
  el('btnReview').addEventListener('click', () => { if (!App.book){UI.showToast('먼저 문서를 열어주세요.');return;} UI.openReviewModal(App.book.id); });
  el('starRating').querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => UI.setStarRating(parseInt(star.dataset.value)));
    star.addEventListener('mouseenter', () => {
      const v=parseInt(star.dataset.value);
      el('starRating').querySelectorAll('.star').forEach(s=>s.classList.toggle('hover',parseInt(s.dataset.value)<=v));
    });
    star.addEventListener('mouseleave', () => el('starRating').querySelectorAll('.star').forEach(s=>s.classList.remove('hover')));
  });
  el('btnSaveReview').addEventListener('click', () => {
    if (!App.book) return;
    const rv = { rating:App.reviewRating, text:el('reviewText').value.trim(), completed:el('completeCheck').checked, savedAt:new Date().toISOString() };
    StateManager.saveReview(App.book.id, rv);
    if (rv.completed) StateManager.upsertLibraryItem({id:App.book.id,completed:true});
    UI.closeReviewModal(); UI.renderLibrary();
    UI.showToast('독서 기록이 저장되었습니다 ★');
  });
  el('btnCloseReview').addEventListener('click',  () => UI.closeReviewModal());
  el('btnCancelReview').addEventListener('click', () => UI.closeReviewModal());
  el('reviewModal').addEventListener('click', e => { if(e.target===el('reviewModal')) UI.closeReviewModal(); });

  /* ─── 보기 모드 토글 버튼 ─── */
  el('btnFlipMode').addEventListener('click',   () => PageFlip.setMode('flip'));
  el('btnScrollMode').addEventListener('click', () => PageFlip.setMode('scroll'));

  /* ─── 팝업 뷰어 버튼 ─── */
  el('btnPopupViewer').addEventListener('click', () => {
    if (App.book) PopupViewer.open(App.book.id);
  });

  /* ─── 진행률 바 클릭 → 팝업 페이지 이동 ─── */
  document.querySelector('.progress-track')?.addEventListener('click', e => {
    if (!PopupPager.active) return;
    const pct  = e.offsetX / e.currentTarget.clientWidth;
    const page = Math.min(Math.floor(pct * PopupPager._total), PopupPager._total - 1);
    PopupPager.go(page);
  });

  /* ─── 리더 영역 클릭 — 탭 존 (스크롤·플립 공통) & 몰입 모드 (플립 전용) ─── */
  el('readerArea').addEventListener('click', e => {
    if (!App.book) return;
    // 텍스트 선택 중이면 무시 (필사 드래그 보호)
    if (window.getSelection()?.toString().length > 0) return;
    // 버튼·링크·모달·사이드바 내부 클릭 무시
    if (e.target.closest('button, a, input, textarea, .modal-overlay, .quote-tooltip, .sidebar')) return;
    // 툴바 영역(플로팅 캡슐 하단) 위의 클릭 무시 — 메뉴바와 충돌 방지
    const toolbarEl = document.querySelector('.toolbar');
    if (toolbarEl) {
      const tbRect = toolbarEl.getBoundingClientRect();
      if (e.clientY <= tbRect.bottom + 6) return;
    }
    const pct = e.clientX / window.innerWidth;
    if (PopupPager.active) {
      // 팝업: 왼쪽 절반 = 이전, 오른쪽 절반 = 다음
      pct < 0.5 ? PopupPager.prev() : PopupPager.next();
    } else if (pct < 0.22) {
      PageFlip.prev();
    } else if (pct > 0.78) {
      PageFlip.next();
    } else if (PageFlip.mode === 'flip') {
      PageFlip.toggleImmersive(); // 몰입 모드: 플립 전용
    }
  });

  /* ─── 마우스 이동 → 호버 인디케이터 (스크롤·플립 공통) ─── */
  document.addEventListener('mousemove', e => {
    const hide = () => { el('tapLeft').style.opacity = '0'; el('tapRight').style.opacity = '0'; };
    if (!App.book) { hide(); return; }
    const toolbarEl = document.querySelector('.toolbar');
    const toolbarBottom = toolbarEl ? toolbarEl.getBoundingClientRect().bottom : 0;
    if (e.clientY <= toolbarBottom) { hide(); return; }
    const pct = e.clientX / window.innerWidth;
    el('tapLeft').style.opacity  = pct < 0.22 ? '1' : '0';
    el('tapRight').style.opacity = pct > 0.78 ? '1' : '0';
  });

  /* ─── 터치 스와이프 ─── */
  let _touchStartX = 0, _touchStartY = 0;
  el('readerArea').addEventListener('touchstart', e => {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
  }, { passive: true });
  el('readerArea').addEventListener('touchend', e => {
    if (!App.book) return;
    const dx = e.changedTouches[0].clientX - _touchStartX;
    const dy = e.changedTouches[0].clientY - _touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (PopupPager.active) {
        dx < 0 ? PopupPager.next() : PopupPager.prev();
      } else if (PageFlip.mode === 'flip') {
        dx < 0 ? PageFlip.next() : PageFlip.prev();
      }
    }
  }, { passive: true });

  /* ─── 마우스 휠 페이지 전환 ─── */
  let _wheelCooldown = false;
  el('readerArea').addEventListener('wheel', e => {
    if (!App.book) return;
    if (!PopupPager.active && PageFlip.mode !== 'flip') return;
    e.preventDefault();
    if (_wheelCooldown) return;
    _wheelCooldown = true;
    const fwd = e.deltaY > 0 || e.deltaX > 0;
    if (PopupPager.active) { fwd ? PopupPager.next() : PopupPager.prev(); }
    else                   { fwd ? PageFlip.next()   : PageFlip.prev();   }
    setTimeout(() => _wheelCooldown = false, 600);
  }, { passive: false });


  /* ─── 언로드 시 저장 ─── */
  window.addEventListener('beforeunload', () => Reader.persistState());

  /* ─── 키보드 단축키 ─── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT') return;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown':
        if (App.book) { e.preventDefault(); PageFlip.next(); }
        break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        if (App.book) { e.preventDefault(); PageFlip.prev(); }
        break;
      case ' ':
        if (!App.book) break;
        e.preventDefault();
        e.shiftKey ? PageFlip.prev() : PageFlip.next();
        break;
        break;
      case '+': case '=':
        if (App.book?.format==='pdf') PdfViewer.zoomIn();
        break;
      case '-':
        if (App.book?.format==='pdf') PdfViewer.zoomOut();
        break;
      case 'w': case 'W':
        if (!e.ctrlKey && !e.metaKey) {
          // 팝업 모드: PDF 너비 맞춤 / 일반 모드: 별도 창 열기
          if (PopupViewer.isPopupMode()) {
            if (App.book?.format === 'pdf') PdfViewer.fitWidth();
          } else if (App.book) {
            PopupViewer.open(App.book.id);
          }
        }
        break;
      case 'p': case 'P':
        if (App.book?.format==='pdf') PdfViewer.fitPage(); break;
      case 'f': case 'F':
        if (!e.ctrlKey&&!e.metaKey) toggleFullscreen(); break;
      case 'h': case 'H':
        Reader.goHome(); break;
      case 't': case 'T':
        UI.switchTab('toc'); break;
      case 'b': case 'B':
        UI.switchTab('quotes'); if(App.book) UI.renderQuotes(App.book.id); break;
      case 'Escape':
        if (el('reviewModal').style.display!=='none') UI.closeReviewModal();
        else if (document.fullscreenElement) document.exitFullscreen();
        break;
    }
  });
}

/* ═══════════════════════════════════════════════════════
   11. 앱 초기화
═══════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }

  await LibraryDB.init();
  UI.setTheme(localStorage.getItem(LS.THEME) || 'light');

  /* ── 팝업 뷰어 모드 ── */
  if (PopupViewer.isPopupMode()) {
    document.body.classList.add('popup-mode');
    document.body.classList.remove('sidebar-open');
    el('homeScreen').style.display  = 'none';
    el('bookWrapper').style.display = 'block';

    PageFlip.init();
    initEvents();

    const bookId = PopupViewer.getBookId();
    if (bookId) {
      UI.setLoading('&#128366; 책을 불러오는 중...');
      try {
        const record = await LibraryDB.getBook(bookId);
        if (record?.fileBlob) {
          await Reader.loadFile(record.fileBlob);
        } else {
          el('bookContent').innerHTML = `
            <div class="reader-error">
              <div class="error-icon">&#128218;</div>
              <div class="error-title">파일을 찾을 수 없습니다</div>
              <div class="error-details">
                <p>저장된 파일 데이터가 없습니다.</p>
                <p>서재에서 파일을 다시 드래그하여 열어 주세요.</p>
              </div>
            </div>`;
        }
      } catch (err) {
        console.error('팝업 로드 오류:', err);
        el('bookContent').innerHTML = `
          <div class="reader-error">
            <div class="error-icon">&#9888;</div>
            <div class="error-title">로드 실패</div>
            <div class="error-details"><p>${escHtml(String(err))}</p></div>
          </div>`;
      }
    }
    // 창 크기 변경 시 페이지네이터 재계산
    let _resizeTimer;
    window.addEventListener('resize', () => {
      if (!PopupPager.active) return;
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => PopupPager.setup(PopupPager._page), 200);
    });

    return; // 팝업 모드 초기화 완료
  }

  /* ── 일반(서재) 모드 ── */
  if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
  el('homeScreen').style.display  = '';
  el('bookWrapper').style.display = 'none';

  PageFlip.init();
  UI.renderDashboardStats();
  UI.renderLibrary();
  UI.renderRecentBooks();
  initEvents();

  // 팝업 창에서 발생한 localStorage 변경 감지 → 서재 UI 실시간 갱신
  window.addEventListener('storage', e => {
    if ([LS.LIBRARY, LS.STATES, LS.REVIEWS, LS.QUOTES].includes(e.key)) {
      UI.renderDashboardStats();
      UI.renderLibrary();
      UI.renderRecentBooks();
    }
  });
});
