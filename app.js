// ============================================================
//  StopWork — PWA App Logic
//  카카오 JavaScript API 키를 index.html의 SDK URL에 설정하세요.
//  https://developers.kakao.com → 내 애플리케이션 → 앱 키 → JavaScript 키
// ============================================================

const WALK_MPS = 67; // 보행 속도 m/분 (약 4km/h 기준)

// ──────────────────────────────────────────────
// 앱 상태
// ──────────────────────────────────────────────
const state = {
  map: null,
  ps: null,                    // kakao.maps.services.Places
  userOverlay: null,
  userLocation: { lat: 37.5665, lng: 126.9780 }, // 기본: 서울시청
  cafes: [],                   // 현재 표시 중인 카페 목록
  markers: [],                 // { id, overlay, el } 배열
  selectedId: null,
  filters: { wifi: false, outlet: false, open: false },
  sortBy: 'distance',
  query: '',
  favorites: JSON.parse(localStorage.getItem('sw_fav') || '[]'),
  history:   JSON.parse(localStorage.getItem('sw_hist') || '[]'),
};

// ──────────────────────────────────────────────
// 초기화
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupFormListeners();
  getLocation()
    .then(coords => { state.userLocation = coords; })
    .catch(() => {/* 기본 위치 유지 */})
    .finally(() => {
      initMap();
      setupBottomSheet();
      setupEventListeners();
    });
});

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject();
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ──────────────────────────────────────────────
// 지도 초기화
// ──────────────────────────────────────────────
function initMap() {
  // 카카오 SDK 로드 실패 시 안내
  if (typeof kakao === 'undefined' || !kakao.maps) {
    document.getElementById('map').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;color:#9e856a;text-align:center;padding:32px;gap:12px;">
        <i class="fa-solid fa-map" style="font-size:40px;color:#3d2a14"></i>
        <p style="font-weight:700;color:#f0ead8">카카오 API 키 미설정</p>
        <p style="font-size:13px;line-height:1.6">
          index.html의 SDK URL 에서<br>
          <code style="color:#d4a373">YOUR_KAKAO_JS_KEY</code>를<br>
          실제 JavaScript 키로 교체해 주세요.<br><br>
          발급: <strong>developers.kakao.com</strong>
        </p>
      </div>`;
    document.getElementById('cafe-list').innerHTML =
      '<div class="list-empty"><i class="fa-solid fa-key"></i><p>API 키를 설정하면<br>주변 카페가 표시됩니다.</p></div>';
    document.getElementById('cafe-count-text').textContent = 'API 키 필요';
    return;
  }

  const { lat, lng } = state.userLocation;
  state.map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(lat, lng),
    level: 4
  });
  state.ps = new kakao.maps.services.Places();

  placeUserMarker(lat, lng);
  searchCafes();

  // 지도 클릭 시 상세 패널 닫기
  kakao.maps.event.addListener(state.map, 'click', closeDetailPanel);
}

function placeUserMarker(lat, lng) {
  if (state.userOverlay) state.userOverlay.setMap(null);
  const dot = document.createElement('div');
  dot.className = 'user-dot';
  state.userOverlay = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(lat, lng),
    content: dot,
    zIndex: 5
  });
  state.userOverlay.setMap(state.map);
}

// ──────────────────────────────────────────────
// 카페 검색 (카카오 Places)
// ──────────────────────────────────────────────
function searchCafes() {
  if (!state.ps) return;

  setCafeListLoading();

  const { lat, lng } = state.userLocation;

  state.ps.categorySearch('CE7', (result, status) => {
    const customCafes = getCustomCafes();

    if (status === kakao.maps.services.Status.OK) {
      const apiCafes = result.map(p => ({
        id:       p.id,
        name:     p.place_name,
        address:  p.road_address_name || p.address_name || '',
        lat:      parseFloat(p.y),
        lng:      parseFloat(p.x),
        distance: parseInt(p.distance, 10) || 0,
        phone:    p.phone || '',
        placeUrl: p.place_url || '',
        source:   'kakao',
        ...estimateWorkScore(p.place_name),
      }));

      // 사용자 등록 카페 + API 카페 (이름 중복 제거 — 소문자·공백 정규화)
      const merged = [...customCafes];
      const normalize = s => s.toLowerCase().replace(/\s+/g, '');
      apiCafes.forEach(c => {
        if (!merged.some(m => normalize(m.name) === normalize(c.name))) merged.push(c);
      });
      state.cafes = merged;
    } else {
      // API 실패 시에도 사용자 등록 카페는 표시
      state.cafes = customCafes;
    }

    renderMarkers();
    renderCafeList();
  }, {
    location: new kakao.maps.LatLng(lat, lng),
    radius: 1000,
    sort: kakao.maps.services.SortBy.DISTANCE,
    size: 15,
  });
}

function getCustomCafes() {
  return JSON.parse(localStorage.getItem('sw_custom') || '[]').map(c => ({
    ...c,
    distance: calcDistance(state.userLocation.lat, state.userLocation.lng, c.lat, c.lng),
  }));
}

// ──────────────────────────────────────────────
// WorkScore 추정 (브랜드 휴리스틱)
// ──────────────────────────────────────────────
function estimateWorkScore(name) {
  const n = name.toLowerCase();
  let wifi = 3, outlet = 3, noise = 3, seat = 3;

  if      (n.includes('스타벅스') || n.includes('starbucks'))     { wifi=5; outlet=5; noise=3; seat=5; }
  else if (n.includes('투썸')     || n.includes('twosome'))       { wifi=4; outlet=4; noise=3; seat=4; }
  else if (n.includes('할리스')   || n.includes('hollys'))        { wifi=4; outlet=4; noise=4; seat=4; }
  else if (n.includes('커피빈')   || n.includes('coffee bean'))   { wifi=4; outlet=4; noise=4; seat=4; }
  else if (n.includes('폴바셋')   || n.includes('paul bassett'))  { wifi=3; outlet=3; noise=4; seat=4; }
  else if (n.includes('메가')     || n.includes('mega'))          { wifi=4; outlet=3; noise=2; seat=3; }
  else if (n.includes('빽다방')   || n.includes('paik'))          { wifi=3; outlet=2; noise=2; seat=3; }
  else if (n.includes('이디야')   || n.includes('ediya'))         { wifi=3; outlet=3; noise=3; seat=3; }
  else if (n.includes('엔제리너스'))                               { wifi=3; outlet=3; noise=3; seat=4; }
  else if (n.includes('컴포즈')   || n.includes('compose'))       { wifi=4; outlet=3; noise=2; seat=3; }
  else if (n.includes('더벤티'))                                   { wifi=3; outlet=3; noise=2; seat=3; }
  else if (n.includes('카페베네') || n.includes('caffe bene'))    { wifi=3; outlet=3; noise=3; seat=4; }
  else if (n.includes('블루보틀') || n.includes('blue bottle'))   { wifi=3; outlet=2; noise=4; seat=4; }

  const score = Math.round((outlet*0.30 + wifi*0.25 + noise*0.25 + seat*0.20) / 5 * 100);
  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : 'C';
  return { wifi, outlet, noise, seat, score, grade };
}

// ──────────────────────────────────────────────
// 필터 / 정렬
// ──────────────────────────────────────────────
function getFilteredCafes() {
  let list = [...state.cafes];

  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q)
    );
  }

  if (state.filters.wifi)   list = list.filter(c => c.wifi >= 4);
  if (state.filters.outlet) list = list.filter(c => c.outlet >= 4);
  if (state.filters.open) {
    // 영업 중 필터 — hours 정보가 있는 카페(직접 등록)에만 적용, 없으면 통과
    list = list.filter(c => {
      if (!c.hours) return true; // hours 없는 카페(API)는 필터 통과
      const m = c.hours.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (!m) return true;
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const open  = +m[1]*60 + +m[2];
      const close = +m[3]*60 + +m[4];
      return cur >= open && cur <= close;
    });
  }

  list.sort(state.sortBy === 'score'
    ? (a, b) => b.score - a.score
    : (a, b) => a.distance - b.distance
  );

  return list;
}

// ──────────────────────────────────────────────
// 마커 렌더링
// ──────────────────────────────────────────────
function renderMarkers() {
  // 기존 마커 제거
  state.markers.forEach(({ overlay }) => overlay.setMap(null));
  state.markers = [];

  getFilteredCafes().forEach(cafe => {
    const el = document.createElement('div');
    el.className = `cafe-marker${state.selectedId === cafe.id ? ' selected' : ''}`;
    el.innerHTML = '<i class="fa-solid fa-mug-hot"></i>';
    el.addEventListener('click', e => {
      e.stopPropagation();
      selectCafe(cafe.id);
    });

    const overlay = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(cafe.lat, cafe.lng),
      content: el,
      zIndex: state.selectedId === cafe.id ? 10 : 3,
      yAnchor: 0.5,
    });
    overlay.setMap(state.map);
    state.markers.push({ id: cafe.id, overlay, el });
    cafe._markerEl = el;
  });
}

// ──────────────────────────────────────────────
// 카페 목록 렌더링
// ──────────────────────────────────────────────
function renderCafeList() {
  const list = getFilteredCafes();
  const container = document.getElementById('cafe-list');
  const countEl   = document.getElementById('cafe-count-text');

  countEl.textContent = `주변 카페 ${list.length}곳`;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="list-empty">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>조건에 맞는 카페가 없습니다.<br>필터를 조정해 보세요.</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  list.forEach(cafe => {
    const walkMin  = calcWalkTime(cafe.distance);
    const isFav    = state.favorites.includes(cafe.id);
    const selected = state.selectedId === cafe.id;

    const card = document.createElement('div');
    card.className = `cafe-card${selected ? ' selected' : ''}`;
    card.dataset.id = cafe.id;

    card.innerHTML = `
      <div class="cafe-card-icon"><i class="fa-solid fa-mug-hot"></i></div>
      <div class="cafe-card-body">
        <div class="cafe-card-name">${escapeHtml(cafe.name)}</div>
        <div class="cafe-card-meta">
          <span>${Math.round(cafe.distance)}m</span>
          <span class="dot"></span>
          <span>도보 ${walkMin}분</span>
          ${isFav ? '<span class="dot"></span><i class="fa-solid fa-bookmark" style="color:var(--accent);font-size:11px"></i>' : ''}
        </div>
        <div class="cafe-card-tags">
          ${cafe.wifi   >= 4 ? '<span class="tag tag-wifi">Wi-Fi</span>' : ''}
          ${cafe.outlet >= 4 ? '<span class="tag tag-outlet">콘센트</span>' : ''}
          ${cafe.noise  >= 4 ? '<span class="tag tag-quiet">조용</span>' : ''}
        </div>
      </div>
      <div class="cafe-card-right">
        <div class="grade-badge grade-${cafe.grade}">${cafe.grade}</div>
        <div class="walk-time">${cafe.score}점</div>
      </div>`;

    card.addEventListener('click', () => selectCafe(cafe.id));
    container.appendChild(card);
  });
}

// ──────────────────────────────────────────────
// 카페 선택
// ──────────────────────────────────────────────
function selectCafe(id) {
  state.selectedId = id;
  const cafe = state.cafes.find(c => c.id === id);
  if (!cafe) return;

  // 지도 이동
  if (state.map) state.map.panTo(new kakao.maps.LatLng(cafe.lat, cafe.lng));

  // 마커 강조 갱신
  state.markers.forEach(m => {
    m.el.classList.toggle('selected', m.id === id);
  });

  // 카드 강조
  document.querySelectorAll('.cafe-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
    if (el.dataset.id === id) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // 상세 패널 열기
  openDetailPanel(cafe);
}

// ──────────────────────────────────────────────
// 상세 패널
// ──────────────────────────────────────────────
function openDetailPanel(cafe) {
  const walkMin = calcWalkTime(cafe.distance);
  const isFav   = state.favorites.includes(cafe.id);

  document.getElementById('detail-panel-title').textContent = cafe.name;

  const favBtn = document.getElementById('btn-favorite');
  favBtn.querySelector('i').className = isFav
    ? 'fa-solid fa-bookmark'
    : 'fa-regular fa-bookmark';
  favBtn.classList.toggle('active', isFav);
  favBtn.dataset.id = cafe.id;

  const scroll = document.getElementById('detail-scroll');
  scroll.innerHTML = `
    <div class="detail-name">${escapeHtml(cafe.name)}</div>
    <div class="detail-address">${escapeHtml(cafe.address) || '주소 정보 없음'}</div>

    <div class="detail-quick-row">
      <div class="quick-chip"><i class="fa-solid fa-route"></i> ${Math.round(cafe.distance)}m</div>
      <div class="quick-chip"><i class="fa-solid fa-person-walking"></i> 도보 ${walkMin}분</div>
      ${cafe.phone ? `<div class="quick-chip"><i class="fa-solid fa-phone"></i> ${escapeHtml(cafe.phone)}</div>` : ''}
    </div>

    <div class="ws-card">
      <div class="ws-header">
        <span class="ws-label">WorkScore</span>
        <div class="ws-score-group">
          <span class="ws-num">${cafe.score}</span>
          <span class="ws-grade grade-${cafe.grade}" style="color:${gradeColor(cafe.grade)}">${cafe.grade}</span>
        </div>
      </div>
      ${wsBar('콘센트', cafe.outlet)}
      ${wsBar('Wi-Fi',  cafe.wifi)}
      ${wsBar('소음',   cafe.noise)}
      ${wsBar('좌석',   cafe.seat)}
    </div>

    ${cafe.tip ? `
    <div class="tip-card">
      <i class="fa-solid fa-lightbulb"></i>
      <p>${escapeHtml(cafe.tip)}</p>
    </div>` : ''}

    <div class="detail-actions">
      <button class="btn-action btn-action-primary" id="btn-navi">
        <i class="fa-solid fa-diamond-turn-right"></i> 길찾기
      </button>
      <button class="btn-action btn-action-secondary" id="btn-save-visit">
        <i class="fa-solid fa-clock-rotate-left"></i> 방문 기록
      </button>
    </div>

    <div class="info-section">
      <div class="info-section-title">카페 정보</div>
      ${cafe.hours ? infoItem('fa-clock', '영업시간', cafe.hours) : ''}
      ${infoItem('fa-wifi',   'Wi-Fi',   wifiLabel(cafe.wifi))}
      ${infoItem('fa-plug',   '콘센트',  outletLabel(cafe.outlet))}
      ${infoItem('fa-volume-low', '소음', noiseLabel(cafe.noise))}
    </div>
  `;

  // 길찾기 버튼
  document.getElementById('btn-navi').addEventListener('click', () => {
    openNavigation(cafe);
  });

  // 방문 기록 버튼
  document.getElementById('btn-save-visit').addEventListener('click', () => {
    addToHistory(cafe);
    showToast(`"${cafe.name}" 방문 기록에 저장했습니다.`);
  });

  document.getElementById('detail-panel').classList.add('open');
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.remove('open');
}

// ── 길찾기 ──
function openNavigation(cafe) {
  const { lat: uLat, lng: uLng } = state.userLocation;
  // 카카오맵 길찾기 URL
  const url = `https://map.kakao.com/link/from/현재위치,${uLat},${uLng}/to/${encodeURIComponent(cafe.name)},${cafe.lat},${cafe.lng}`;
  window.open(url, '_blank');
}

// ── WorkScore 바 HTML ──
function wsBar(label, val) {
  const pct = Math.round(val / 5 * 100);
  return `
    <div class="ws-row">
      <span class="ws-row-label">${label}</span>
      <div class="ws-track"><div class="ws-fill" style="width:${pct}%"></div></div>
      <span class="ws-val">${val}/5</span>
    </div>`;
}

function infoItem(icon, label, val) {
  return `
    <div class="info-item">
      <i class="fa-solid ${icon}"></i>
      <div class="info-item-body">
        <div class="info-item-label">${label}</div>
        <div class="info-item-val">${escapeHtml(String(val))}</div>
      </div>
    </div>`;
}

function gradeColor(g) {
  return { S: 'var(--green)', A: 'var(--yellow)', B: 'var(--accent)', C: 'var(--red)' }[g];
}

function wifiLabel(v)   { return v>=5?'초고속 (영상통화 원활)':v>=3?'보통 (웹서핑 가능)':'느림/불안정'; }
function outletLabel(v) { return v>=5?'충분 (대부분 좌석)':v>=3?'보통 (일부 테이블)':'희박 (거의 없음)'; }
function noiseLabel(v)  { return v>=5?'조용 (집중 적합)':v>=3?'보통 (대화 소리)':'왁자지껄 (이어폰 필수)'; }

// ──────────────────────────────────────────────
// 즐겨찾기
// ──────────────────────────────────────────────
function toggleFavorite(id) {
  const idx = state.favorites.indexOf(id);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    showToast('즐겨찾기에서 제거했습니다.');
  } else {
    state.favorites.push(id);
    showToast('즐겨찾기에 추가했습니다.');
  }
  localStorage.setItem('sw_fav', JSON.stringify(state.favorites));

  // 즐겨찾기 버튼 UI 갱신
  const favBtn = document.getElementById('btn-favorite');
  const isFav  = state.favorites.includes(id);
  favBtn.querySelector('i').className = isFav ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark';
  favBtn.classList.toggle('active', isFav);

  renderCafeList();
}

function renderFavorites() {
  const container = document.getElementById('favorites-list');
  const favCafes  = state.cafes.filter(c => state.favorites.includes(c.id));

  if (favCafes.length === 0) {
    container.innerHTML = '<div class="list-empty"><i class="fa-regular fa-bookmark"></i><p>즐겨찾기한 카페가 없습니다.</p></div>';
    return;
  }

  container.innerHTML = '';
  favCafes.forEach(cafe => {
    const card = makeMiniCard(cafe);
    container.appendChild(card);
  });
}

// ──────────────────────────────────────────────
// 방문 기록
// ──────────────────────────────────────────────
function addToHistory(cafe) {
  const entry = {
    id:        cafe.id,
    name:      cafe.name,
    address:   cafe.address,
    score:     cafe.score,
    grade:     cafe.grade,
    distance:  cafe.distance,
    visitedAt: new Date().toISOString(),
  };
  state.history = [entry, ...state.history.filter(h => h.id !== cafe.id)].slice(0, 50);
  localStorage.setItem('sw_hist', JSON.stringify(state.history));
}

function renderHistory() {
  const container = document.getElementById('history-list');

  if (state.history.length === 0) {
    container.innerHTML = '<div class="list-empty"><i class="fa-solid fa-clock-rotate-left"></i><p>방문 기록이 없습니다.</p></div>';
    return;
  }

  container.innerHTML = '';
  state.history.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'cafe-card';
    div.style.cursor = 'default';
    const dt = new Date(entry.visitedAt);
    const dateStr = `${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours()}:${String(dt.getMinutes()).padStart(2,'0')}`;
    div.innerHTML = `
      <div class="cafe-card-icon"><i class="fa-solid fa-mug-hot"></i></div>
      <div class="cafe-card-body">
        <div class="cafe-card-name">${escapeHtml(entry.name)}</div>
        <div class="cafe-card-meta"><span>${dateStr}</span></div>
      </div>
      <div class="cafe-card-right">
        <div class="grade-badge grade-${entry.grade}">${entry.grade}</div>
      </div>`;
    container.appendChild(div);
  });
}

// ── 미니 카드 (즐겨찾기용) ──
function makeMiniCard(cafe) {
  const card = document.createElement('div');
  card.className = 'cafe-card';
  card.innerHTML = `
    <div class="cafe-card-icon"><i class="fa-solid fa-mug-hot"></i></div>
    <div class="cafe-card-body">
      <div class="cafe-card-name">${escapeHtml(cafe.name)}</div>
      <div class="cafe-card-meta"><span>${escapeHtml(cafe.address)}</span></div>
    </div>
    <div class="cafe-card-right">
      <div class="grade-badge grade-${cafe.grade}">${cafe.grade}</div>
    </div>`;
  card.addEventListener('click', () => {
    selectCafe(cafe.id);
    closeSidePanel('favorites-panel');
  });
  return card;
}

// ──────────────────────────────────────────────
// 카페 직접 등록
// ──────────────────────────────────────────────
function setupFormListeners() {
  document.getElementById('add-cafe-form').addEventListener('submit', e => {
    e.preventDefault();

    const name   = document.getElementById('fc-name').value.trim();
    const addr   = document.getElementById('fc-addr').value.trim();
    const outlet = parseInt(document.getElementById('fc-outlet').value, 10);
    const wifi   = parseInt(document.getElementById('fc-wifi').value, 10);
    const noise  = parseInt(document.getElementById('fc-noise').value, 10);
    const hours  = document.getElementById('fc-hours').value.trim();
    const tip    = document.getElementById('fc-tip').value.trim();
    const seat   = 3; // 기본값

    const score = Math.round((outlet*0.30 + wifi*0.25 + noise*0.25 + seat*0.20) / 5 * 100);
    const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : 'C';

    const submitBtn = e.target.querySelector('.btn-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '위치 확인 중...';

    // 주소가 있으면 카카오 Geocoding으로 실제 좌표 변환, 없으면 현재 위치 사용
    resolveCoords(addr, name).then(({ lat, lng, distance }) => {
      const newCafe = {
        id:       `custom-${Date.now()}`,
        name,
        address:  addr,
        lat, lng, distance,
        phone:    '',
        placeUrl: '',
        source:   'user',
        outlet, wifi, noise, seat, score, grade,
        hours:    hours || '',
        tip:      tip   || '',
      };

      const custom = JSON.parse(localStorage.getItem('sw_custom') || '[]');
      custom.unshift(newCafe);
      localStorage.setItem('sw_custom', JSON.stringify(custom));

      state.cafes.unshift(newCafe);
      renderMarkers();
      renderCafeList();
      closeModal();
      showToast(`"${name}" 등록 완료!`);
      e.target.reset();
    }).finally(() => {
      submitBtn.disabled = false;
      submitBtn.textContent = '등록하기';
    });
  });
}

/**
 * 주소 문자열 → { lat, lng, distance } 반환
 * 카카오 Geocoder 사용. 실패 시 현재 위치 반환.
 */
function resolveCoords(addr, cafeName) {
  return new Promise(resolve => {
    // 주소가 없거나 Geocoder를 사용할 수 없으면 현재 위치 사용
    if (!addr || typeof kakao === 'undefined' || !kakao.maps || !kakao.maps.services) {
      resolve({
        lat: state.userLocation.lat,
        lng: state.userLocation.lng,
        distance: 0,
      });
      return;
    }

    const geocoder = new kakao.maps.services.Geocoder();
    // 주소로 먼저 시도, 실패 시 키워드 검색으로 폴백
    geocoder.addressSearch(addr, (result, status) => {
      if (status === kakao.maps.services.Status.OK && result.length > 0) {
        const lat = parseFloat(result[0].y);
        const lng = parseFloat(result[0].x);
        resolve({
          lat, lng,
          distance: calcDistance(state.userLocation.lat, state.userLocation.lng, lat, lng),
        });
      } else {
        // 주소 검색 실패 → 카페 이름으로 키워드 검색 시도
        const ps = new kakao.maps.services.Places();
        ps.keywordSearch(cafeName + ' ' + addr, (r2, s2) => {
          if (s2 === kakao.maps.services.Status.OK && r2.length > 0) {
            const lat = parseFloat(r2[0].y);
            const lng = parseFloat(r2[0].x);
            resolve({
              lat, lng,
              distance: calcDistance(state.userLocation.lat, state.userLocation.lng, lat, lng),
            });
          } else {
            // 모두 실패 시 현재 위치 사용
            resolve({
              lat: state.userLocation.lat,
              lng: state.userLocation.lng,
              distance: 0,
            });
          }
        });
      }
    });
  });
}

// ──────────────────────────────────────────────
// 바텀 시트 드래그
// ──────────────────────────────────────────────
function setupBottomSheet() {
  const sheet   = document.getElementById('bottom-sheet');
  const handle  = document.getElementById('sheet-handle-area');
  const HEIGHTS = { peek: 110, mid: Math.round(window.innerHeight * 0.44), full: Math.round(window.innerHeight * 0.86) };

  let startY = 0, startH = 0, dragging = false;

  function snap(currentH) {
    const dists = Object.entries(HEIGHTS).map(([k, v]) => ({ k, d: Math.abs(v - currentH) }));
    dists.sort((a, b) => a.d - b.d);
    const target = HEIGHTS[dists[0].k];
    sheet.style.height = target + 'px';
    sheet.className = `bottom-sheet ${dists[0].k}`;
  }

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    startH = sheet.offsetHeight;
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = startY - e.touches[0].clientY;
    const newH = Math.max(HEIGHTS.peek, Math.min(HEIGHTS.full, startH + dy));
    sheet.style.height = newH + 'px';
  }, { passive: true });

  handle.addEventListener('touchend', () => {
    dragging = false;
    sheet.style.transition = '';
    snap(sheet.offsetHeight);
  });

  // 핸들 클릭: peek ↔ mid ↔ full 순환
  handle.addEventListener('click', () => {
    const cur = sheet.offsetHeight;
    if (cur <= HEIGHTS.peek + 10) {
      sheet.style.height = HEIGHTS.mid + 'px';
      sheet.className = 'bottom-sheet mid';
    } else if (cur <= HEIGHTS.mid + 10) {
      sheet.style.height = HEIGHTS.full + 'px';
      sheet.className = 'bottom-sheet full';
    } else {
      sheet.style.height = HEIGHTS.peek + 'px';
      sheet.className = 'bottom-sheet peek';
    }
  });
}

// ──────────────────────────────────────────────
// 이벤트 리스너
// ──────────────────────────────────────────────
function setupEventListeners() {
  // ── GPS 재탐지 ──
  document.getElementById('btn-locate').addEventListener('click', () => {
    const btn = document.getElementById('btn-locate');
    btn.querySelector('i').className = 'fa-solid fa-circle-notch fa-spin';
    getLocation()
      .then(coords => {
        state.userLocation = coords;
        if (state.map) {
          placeUserMarker(coords.lat, coords.lng);
          state.map.setCenter(new kakao.maps.LatLng(coords.lat, coords.lng));
          searchCafes();
        }
      })
      .catch(() => showToast('위치 확인에 실패했습니다.'))
      .finally(() => { btn.querySelector('i').className = 'fa-solid fa-crosshairs'; });
  });

  // ── 필터 패널 토글 ──
  document.getElementById('btn-filter-toggle').addEventListener('click', () => {
    const panel = document.getElementById('filter-panel');
    panel.classList.toggle('open');
    document.getElementById('btn-filter-toggle').classList.toggle('active', panel.classList.contains('open'));
  });

  // ── 검색 입력 ──
  const searchInput = document.getElementById('search-input');
  const clearBtn    = document.getElementById('btn-clear-search');

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    clearBtn.style.display = state.query ? 'block' : 'none';
    renderMarkers();
    renderCafeList();
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearBtn.style.display = 'none';
    renderMarkers();
    renderCafeList();
    searchInput.focus();
  });

  // ── 필터 칩 ──
  document.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      state.filters[f] = !state.filters[f];
      btn.classList.toggle('active', state.filters[f]);
      renderMarkers();
      renderCafeList();
    });
  });

  // ── 정렬 변경 ──
  document.getElementById('sort-select').addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderMarkers();
    renderCafeList();
  });

  // ── 상세 패널 닫기 ──
  document.getElementById('btn-close-detail').addEventListener('click', closeDetailPanel);

  // ── 즐겨찾기 버튼 ──
  document.getElementById('btn-favorite').addEventListener('click', e => {
    toggleFavorite(e.currentTarget.dataset.id);
  });

  // ── 하단 내비게이션 ──
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const nav = btn.dataset.nav;
      if (nav === 'favorites') { renderFavorites(); openSidePanel('favorites-panel'); }
      if (nav === 'history')   { renderHistory();   openSidePanel('history-panel');   }
      if (nav === 'home')      { closeSidePanel('favorites-panel'); closeSidePanel('history-panel'); }
    });
  });

  // ── 사이드 패널 닫기 버튼 ──
  document.querySelectorAll('.side-panel-close').forEach(btn => {
    btn.addEventListener('click', () => {
      closeSidePanel(btn.dataset.panel);
      document.querySelector('.nav-btn[data-nav="home"]').click();
    });
  });

  // ── 카페 등록 모달 ──
  document.getElementById('btn-add-cafe').addEventListener('click', openModal);
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────
function setCafeListLoading() {
  document.getElementById('cafe-list').innerHTML =
    '<div class="list-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><p>주변 카페 검색 중...</p></div>';
  document.getElementById('cafe-count-text').textContent = '검색 중...';
}

function openSidePanel(id)  { document.getElementById(id).classList.add('open'); }
function closeSidePanel(id) { document.getElementById(id).classList.remove('open'); }
function openModal()  { document.getElementById('modal-add').classList.add('open'); }
function closeModal() { document.getElementById('modal-add').classList.remove('open'); }

function calcWalkTime(distanceM) {
  return Math.max(1, Math.ceil(distanceM / WALK_MPS));
}

function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
