// app/api/wp/post/route.ts — V3.3
// 변경사항: 이미지 URL 반환, 본문 1500자+, 확장 SEO 키워드, WP이미지업로드 제거

import { NextRequest, NextResponse } from "next/server"

type PublishType = "draft" | "publish"
type FormatType  = "hybrid" | "review" | "compare"

function safeStr(v: any): string { return typeof v === "string" ? v : "" }
function json(res: any, status = 200) { return NextResponse.json(res, { status }) }
function unauthorized() { return json({ error: "Unauthorized" }, 401) }
function badRequest(msg: string) { return json({ error: msg }, 400) }
function getApiKey() {
  return safeStr(process.env.API_KEY) || safeStr(process.env.INTERNAL_API_KEY) || ""
}
function getFutureDate(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

// ─── Agoda API ─────────────────────────────────
async function agodaGetHotelById(hotelId: string) {
  const auth = process.env.AGODA_AUTH || ""
  let siteId = process.env.AGODA_SITE_ID || "1959499"
  let apiKey  = process.env.AGODA_API_KEY  || "24680cfc-3bff-4410-845d-5cb97d854532"
  if (auth.includes(":")) {
    const parts = auth.split(":")
    if (parts.length === 3 && parts[0] === parts[1]) { siteId = parts[0]; apiKey = parts[2] }
    else { siteId = parts[0]; apiKey = parts.slice(1).join(":") }
  }
  const body = {
    criteria: {
      checkInDate: getFutureDate(7), checkOutDate: getFutureDate(10),
      hotelId: [Number(hotelId)],
      additional: { currency:"KRW", language:"ko-kr", discountOnly:false,
        occupancy:{ numberOfAdult:2, numberOfChildren:0 } },
    },
  }
  const res  = await fetch("http://affiliateapi7643.agoda.com/affiliateservice/lt_v1", {
    method:"POST",
    headers:{ "Content-Type":"application/json","Accept-Encoding":"gzip,deflate",
      "Authorization":`${siteId}:${apiKey}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

// ─── WP 포스트 발행 (이미지 업로드 없이 URL만 사용) ───
async function wpCreatePost(params: {
  title:string; content:string; status:PublishType
  category?:number; slug?:string
  seoTitle?:string; seoDescription?:string; focusKeyword?:string
}) {
  const WP_URL  = safeStr(process.env.WP_URL)
  const WP_USER = safeStr(process.env.WP_USERNAME)
  const WP_PASS = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)
  if (!WP_URL) throw new Error("WP_URL missing")
  const token = Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")
  const body: any = {
    title: params.title, content: params.content, status: params.status,
    ...(params.category && { categories:[params.category] }),
    ...(params.slug     && { slug: params.slug }),
    meta: {
      rank_math_title:         params.seoTitle       || params.title,
      rank_math_description:   params.seoDescription || "",
      rank_math_focus_keyword: params.focusKeyword   || "",
    },
  }
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method:"POST",
    headers:{ Authorization:`Basic ${token}`,"Content-Type":"application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ─── 스타일 상수 ───────────────────────────────
const BTN_RED   = `background:#ff5a5f;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;letter-spacing:-.3px;`
const BTN_BLUE  = `background:#1B56C5;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;letter-spacing:-.3px;`
const BTN_GREEN = `background:#16a34a;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;letter-spacing:-.3px;`
const FALLBACK  = "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80"

function img(src:string, alt:string, caption="") {
  return `<figure style="margin:0 0 28px 0;">
  <img src="${src}" alt="${alt}"
    onerror="this.src='${FALLBACK}'"
    style="width:100%;max-height:520px;object-fit:cover;border-radius:16px;"/>
  ${caption ? `<figcaption style="text-align:center;font-size:13px;color:#6b7280;margin-top:8px;">${caption}</figcaption>` : ""}
</figure>`
}

function cta(url:string, style:string, text:string) {
  return `<div style="margin:28px 0;text-align:center;">
  <a href="${url}" target="_blank" rel="nofollow noopener" style="${style}">${text}</a>
  <p style="font-size:12px;color:#9ca3af;margin-top:8px;">※ 아고다 공식 제휴 링크 · 추가 비용 없이 동일 최저가 보장</p>
</div>`
}

function faqSchema(faqs:{q:string,a:string}[]) {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":${
    JSON.stringify(faqs.map(f=>({
      "@type":"Question","name":f.q,
      "acceptedAnswer":{"@type":"Answer","text":f.a}
    })))
  }}</script>`
}

function hotelSchema(name:string,addr:string,score:string,reviews:string) {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Hotel","name":"${name}","address":"${addr}","aggregateRating":{"@type":"AggregateRating","ratingValue":"${score}","reviewCount":"${reviews}"}}</script>`
}

// ══════════════════════════════════════════════
// A. HYBRID — SEO + 전환 균형 (1500자+ 확장형)
// ══════════════════════════════════════════════
function buildHybridHtml(p:{
  hotelName:string; affiliateUrl:string; keyword:string; cityUrl?:string
  photos:string[]; score?:string; reviews?:string; location?:string
  checkin?:string; checkout?:string; starRating?:number
}) {
  const heroSrc = p.photos[0] || FALLBACK
  const photo2  = p.photos[1] || FALLBACK
  const photo3  = p.photos[2] || FALLBACK
  const stars   = "★".repeat(Math.min(5, p.starRating||5)) + "☆".repeat(Math.max(0, 5-(p.starRating||5)))
  const cityLink = p.cityUrl
    ? `<a href="${p.cityUrl}" target="_blank" rel="noopener" style="color:#1B56C5;font-weight:700;text-decoration:underline;">${p.location?.split(",")[0]||"해당 도시"} 전체 호텔 보기 →</a>`
    : ""
  const faqs = [
    {q:`${p.hotelName} 아고다 예약 시 체크인/체크아웃 시간은?`,
      a:`일반적으로 체크인 ${p.checkin||"15:00"}, 체크아웃 ${p.checkout||"12:00"}입니다. 얼리체크인·레이트체크아웃은 예약 시 요청하거나 현장에서 추가 요금을 내고 이용 가능합니다.`},
    {q:`${p.hotelName} 아고다 평점과 리뷰는 어떤가요?`,
      a:`아고다 기준 ${p.score||"–"}/10점, 리뷰 ${p.reviews||"다수"} 건입니다. 청결도·직원 서비스·위치 항목에서 꾸준히 높은 점수를 받고 있습니다.`},
    {q:`무료취소 가능한 요금제를 선택하는 게 유리한가요?`,
      a:`무료취소 가능 요금제는 대체로 일반 요금보다 약간 높지만, 일정 변경 리스크가 있다면 선택하는 것이 유리합니다. 단, "마감 날짜+시간"을 반드시 확인하세요.`},
    {q:`날짜를 1~2일 바꾸면 가격이 달라지나요?`,
      a:`네, 요일과 시즌에 따라 가격 차이가 큽니다. 체크인 날짜를 전후 1~2일 이동해보면 수만 원 이상 절약이 가능한 경우가 많습니다.`},
    {q:`${p.hotelName} 조식 포함 옵션이 유리한가요?`,
      a:`성인 2명 기준 조식 가격을 비교해보세요. 외부 식사 비용과 비교했을 때 포함 옵션이 유리한 경우가 많습니다. 단, 아침을 가볍게 먹는 여행자라면 미포함 후 편의점 활용이 더 경제적입니다.`},
  ]

  return `${img(heroSrc, `${p.hotelName} 전경 — 아고다 최저가`, `${p.hotelName} · ${p.location||""} · 아고다 공식 제휴`)}

<h1 style="font-size:clamp(22px,3vw,28px);font-weight:800;line-height:1.35;letter-spacing:-.5px;margin-bottom:16px;">${p.keyword} 완벽 가이드 — ${p.hotelName} 후기·위치·가격·예약 전략 총정리</h1>

<p style="font-size:16px;color:#374151;line-height:1.9;margin-bottom:20px;">
<strong>${p.keyword}</strong>을 검색하는 여행자라면 가장 먼저 확인하는 것이 "실제 투숙 후기"와 "날짜별 가격 변동"입니다.
이 글은 <strong>${p.hotelName}</strong>의 위치 편의성, 객실 퀄리티, 조식 수준, 수영장 이용 환경, 그리고 아고다 예약 시 절약 전략까지
<strong>실투숙자 리뷰 데이터를 기반으로 정리한 정보형+리뷰형 통합 가이드</strong>입니다.
예약 전에 꼭 읽어야 할 체크포인트를 중심으로 구성했습니다.
</p>

${cta(p.affiliateUrl, BTN_RED, "👉 아고다에서 최저가 지금 확인하기")}

<div style="background:#f0f7ff;border-left:5px solid #1B56C5;padding:18px 22px;border-radius:10px;margin:24px 0;">
  <p style="font-weight:800;font-size:16px;margin:0 0 8px;">📍 ${p.hotelName} 핵심 정보 한눈에 보기</p>
  <table style="width:100%;font-size:14px;border-collapse:collapse;">
    <tr><td style="padding:5px 0;color:#6b7280;width:100px;">위치</td><td style="font-weight:600;">${p.location||"아고다 예약 페이지 확인"}</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">아고다 평점</td><td style="font-weight:600;">${p.score||"–"} / 10 (리뷰 ${p.reviews||"다수"}건)</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">호텔 등급</td><td style="font-weight:600;">${stars} (${p.starRating||5}성급)</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">체크인/아웃</td><td style="font-weight:600;">${p.checkin||"15:00"} / ${p.checkout||"12:00"}</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">예약 방법</td><td style="font-weight:600;">아고다 공식 제휴 링크 (추가 비용 없음)</td></tr>
  </table>
  ${cityLink ? `<p style="margin:10px 0 0;font-size:13px;">${cityLink}</p>` : ""}
</div>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">✅ ${p.hotelName} 실투숙자 후기 — 반복되는 장점 분석</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
${p.hotelName}의 아고다 리뷰를 분석하면 <strong>위치 편의성, 청결도, 직원 서비스</strong>가 압도적으로 많이 언급됩니다.
특히 체크인 프로세스에 대한 긍정적 평가가 많으며, <strong>"기대보다 훨씬 좋았다"</strong>는 표현이 자주 등장합니다.
이는 단순한 만족을 넘어 <strong>재방문 의사와 가성비 만족도가 높다</strong>는 신호로 해석됩니다.
조식 퀄리티와 수영장 환경에 대해서도 꾸준히 높은 평점을 받고 있으며,
야경이나 풀뷰를 언급하는 후기도 눈에 띕니다.
</p>

${img(photo2, `${p.hotelName} 객실 내부`, `객실 내부 · 실제 투숙 환경`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">⚠️ 솔직하게 — 아쉬운 점과 주의사항</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
어떤 호텔도 완벽할 수 없습니다. ${p.hotelName}에서 반복적으로 언급되는 아쉬운 점은 다음과 같습니다.
</p>
<ul style="margin:12px 0 16px 22px;line-height:2.2;font-size:16px;color:#374151;">
  <li><strong>성수기 조식 혼잡</strong> — 오전 8~9시는 대기가 생길 수 있습니다. <span style="color:#1B56C5;">7시 초반 방문을 추천합니다.</span></li>
  <li><strong>객실 컨디션 편차</strong> — 동·층·방향에 따라 뷰와 소음이 다릅니다. 예약 시 요청 메모를 남기는 것이 효과적입니다.</li>
  <li><strong>성수기 체크인 대기</strong> — 오후 3~4시 피크 시간 이후 도착하면 대기가 줄어듭니다.</li>
  <li><strong>추가 요금 항목</strong> — 리조트 피, 주차비, 와이파이 등 추가 요금을 예약 전 반드시 확인하세요.</li>
</ul>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">🛏️ 객실 선택 가이드 — 같은 호텔, 다른 만족도</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
${p.hotelName}에서 만족도를 가르는 가장 큰 요소는 <strong>어떤 객실 타입을 선택하느냐</strong>입니다.
동일한 호텔이라도 뷰, 층수, 침대 배치에 따라 체험이 완전히 달라집니다.
</p>
<ul style="margin:12px 0 16px 22px;line-height:2.2;font-size:16px;color:#374151;">
  <li><strong>가족 여행</strong> — 패밀리룸 또는 커넥팅룸 선택, 아동 추가 요금·소파베드 유무 확인 필수</li>
  <li><strong>커플·허니문</strong> — 오션뷰·가든뷰·도심뷰 중 선호 뷰 선택, 발코니·욕조 있는 객실 추천</li>
  <li><strong>비즈니스 출장</strong> — 고층 클럽 룸 또는 이그제큐티브 플로어, 빠른 체크인 서비스</li>
  <li><strong>부모님·어르신 동반</strong> — 저층 엘리베이터 인접, 조식당·수영장 동선 확인</li>
</ul>

${img(photo3, `${p.hotelName} 시설`, `부대시설 · 수영장 · 레스토랑`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">🍳 조식 & 수영장 — '있다'보다 '어떻게 이용하느냐'가 핵심</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
조식은 단순히 "포함 여부"보다 <strong>총액 기준 가성비</strong>를 따지는 것이 중요합니다.
성인 2명 기준으로 조식 포함 요금과 외부 식사 비용을 비교해보세요.
수영장은 <strong>오전 일찍</strong> 방문하면 인파 없이 여유롭게 이용할 수 있습니다.
그늘 자리 확보와 타월 제공 여부, 키즈풀 분리 여부도 사전에 확인하면 좋습니다.
</p>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">👥 이런 여행자에게 추천 / 비추천</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0;">
  <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:16px;">
    <p style="font-weight:800;color:#16a34a;margin-bottom:10px;font-size:15px;">✅ 적극 추천</p>
    <ul style="margin:0 0 0 18px;font-size:14px;line-height:2.1;color:#374151;">
      <li>허니문·기념일 커플 여행</li>
      <li>리조트에서 올인클루시브 즐기고 싶은 분</li>
      <li>비즈니스 출장 + 워케이션</li>
      <li>부모님 효도 여행</li>
    </ul>
  </div>
  <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:16px;">
    <p style="font-weight:800;color:#dc2626;margin-bottom:10px;font-size:15px;">❌ 비추천</p>
    <ul style="margin:0 0 0 18px;font-size:14px;line-height:2.1;color:#374151;">
      <li>도심 교통 접근성이 최우선인 분</li>
      <li>숙소는 잠만 자는 극가성비 배낭여행자</li>
      <li>관광지 도보 이동이 많은 일정</li>
    </ul>
  </div>
</div>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">💰 아고다 예약 절약 전략 — 손해 없이 최저가로 잡는 법</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
아고다에서 같은 호텔이라도 <strong>날짜, 옵션, 조회 시점에 따라 가격이 크게 달라집니다.</strong>
아래 5단계 전략을 따르면 불필요한 지출을 줄일 수 있습니다.
</p>
<ol style="margin:12px 0 16px 22px;line-height:2.4;font-size:16px;color:#374151;">
  <li><strong>체크인 날짜 ±1~2일 이동</strong> — 요일별 가격 차이가 크므로 날짜 이동 비교 필수</li>
  <li><strong>세금·봉사료 포함 총액 기준</strong>으로 비교 — 표시 가격보다 최종 결제 금액 확인</li>
  <li><strong>무료취소 마감 "날짜+시간"</strong> 정확히 메모 — 부분 환불 조건도 체크</li>
  <li><strong>조식 포함 유불리 계산</strong> — 인원수 × 조식 단가 vs 외부 식사 비용 비교</li>
  <li><strong>연박 분할 예약</strong> — 특정 날짜만 가격이 저렴한 경우 분리 예약도 고려</li>
</ol>

${cta(p.affiliateUrl, BTN_BLUE, "🏨 아고다에서 날짜별 가격 비교하기")}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">📋 예약 전 최종 체크리스트</h2>
<div style="background:#f8fafc;border-radius:12px;padding:18px 22px;font-size:15px;line-height:2.3;">
  ☐ 무료취소 가능 여부 &amp; 정확한 마감 시간 확인<br>
  ☐ 세금·봉사료 포함 <strong>총액</strong> 기준 타 플랫폼 비교<br>
  ☐ 체크인 날짜 ±2일 이동 가격 비교<br>
  ☐ 조식 포함 여부 인원 기준 유불리 계산<br>
  ☐ 객실 타입·층수·뷰 특이 요청 메모 작성<br>
  ☐ 리조트 피·주차비 등 추가 요금 항목 확인<br>
  ☐ 아동 동반 시 추가 요금·어메니티 확인
</div>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">❓ 자주 묻는 질문 (FAQ)</h2>
${faqs.map(f=>`<details style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
  <summary style="padding:15px 18px;font-weight:700;cursor:pointer;background:#f8fafc;font-size:15px;">Q. ${f.q}</summary>
  <div style="padding:15px 18px;font-size:15px;line-height:1.8;color:#374151;background:#fff;">A. ${f.a}</div>
</details>`).join("")}
${faqSchema(faqs)}

${cta(p.affiliateUrl, BTN_GREEN, "📅 아고다 최저가로 지금 바로 예약하기 →")}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">📌 ${p.hotelName} 아고다 예약 총정리</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
<strong>${p.keyword}</strong>를 검색한다면 ${p.hotelName}은 위치·서비스·시설 세 가지 측면에서 균형 잡힌 선택입니다.
아고다를 통해 예약하면 날짜를 1~2일 바꿔보는 것만으로도 비용을 절약할 수 있으며,
무료취소 조건이면 부담 없이 먼저 예약하고 확정하는 전략이 유효합니다.
<strong>세금·봉사료 포함 총액 기준</strong>으로 비교하고, 아래 링크에서 현재 최저가를 확인해보세요.
</p>
${cta(p.affiliateUrl, BTN_RED, "👉 ${p.hotelName} 아고다 최저가 확인 →")}

<p style="font-size:13px;color:#9ca3af;margin-top:16px;">
#${p.keyword.replace(/\s+/g,"")} #${p.hotelName.replace(/\s+/g,"")} #아고다 #호텔예약 #${p.location?.split(",")[0]||""}호텔 #숙소추천 #여행팁 #아고다최저가 #호텔후기 #${(p.starRating||5)}성급호텔
</p>`
}

// ─── review 빌더 ───────────────────────────────
function buildReviewHtml(p: Parameters<typeof buildHybridHtml>[0]) {
  const heroSrc = p.photos[0]||FALLBACK
  const photo2  = p.photos[1]||FALLBACK
  const photo3  = p.photos[2]||FALLBACK
  const faqs = [
    {q:`${p.hotelName} 실제로 묵어볼 만한가요?`, a:`아고다 리뷰 ${p.reviews||"다수"}건 기준, 청결도·직원 서비스·위치에서 꾸준히 ${p.score||"높은"}/10점대를 받고 있습니다. 기대치를 현실적으로 맞추면 만족도가 높습니다.`},
    {q:`가장 많이 언급되는 단점은 무엇인가요?`, a:`성수기 조식 대기, 일부 객실 소음, 추가 요금 항목이 반복 언급됩니다. 예약 시 층·동 요청을 남기면 편차를 줄일 수 있습니다.`},
    {q:`커플·허니문에 적합한가요?`, a:`분위기와 프라이버시를 중시하는 커플에게 적합합니다. 오션뷰 또는 고층 객실 선택 시 만족도가 더 높습니다.`},
    {q:`체크인 대기 없이 빠르게 입실하려면?`, a:`얼리체크인을 사전 요청하거나, 성수기는 오후 5시 이후 도착하면 대기 없이 바로 입실 가능한 경우가 많습니다.`},
  ]
  return `${img(heroSrc, `${p.hotelName} 실투숙 리뷰`, `${p.hotelName} · 아고다 리뷰 ${p.reviews||""}건 · 평점 ${p.score||""}/10`)}

<h1 style="font-size:clamp(22px,3vw,28px);font-weight:800;line-height:1.35;letter-spacing:-.5px;margin-bottom:16px;">${p.hotelName} 솔직 후기 — 실제로 묵어보면 이런 느낌입니다 (${new Date().getFullYear()}년 최신)</h1>

<p style="font-size:16px;color:#374151;line-height:1.9;margin-bottom:20px;">
<strong>"사진과 실제가 얼마나 다를까?"</strong> ${p.hotelName}을 검색하는 여행자라면 누구나 하는 질문입니다.
이 글은 아고다 리뷰 <strong>${p.reviews||"수백"}건</strong>에서 반복적으로 등장하는 키워드를 분석해
<strong>체크인부터 체크아웃까지 실제 투숙 흐름 중심</strong>으로 정리했습니다.
평점 ${p.score||"–"}/10이 의미하는 것이 무엇인지, 누구에게 맞고 맞지 않는지까지 솔직하게 알려드립니다.
</p>

${cta(p.affiliateUrl, BTN_RED, "👉 아고다에서 현재 가격 확인하기")}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">🚪 첫인상 — 도착하는 순간부터 시작되는 투숙 경험</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
${p.hotelName}에 도착하면 가장 먼저 로비의 규모감과 직원의 웰컴 서비스가 눈에 들어옵니다.
아고다 리뷰에서 <strong>"도착하자마자 기대 이상이었다"</strong>는 표현이 반복되는 이유가 여기에 있습니다.
체크인 카운터까지의 동선이 짧고, 안내 직원이 항상 배치되어 있어 첫 인상은 매우 긍정적입니다.
단, 성수기에는 오후 3~4시 사이 체크인 대기줄이 생길 수 있으므로
<strong>오후 5시 이후 도착</strong>하거나 사전에 얼리체크인을 요청하는 것이 좋습니다.
</p>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">📍 위치 체감 — 지도보다 실제 이동이 중요합니다</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
${p.location||"해당 지역"}에 위치한 ${p.hotelName}은 지도상 위치보다 <strong>실제 도보 이동 체감</strong>이 훨씬 중요합니다.
주요 관광지·쇼핑 거리·대중교통까지의 실제 이동 시간을 미리 확인해두세요.
리뷰에서 자주 언급되는 팁은 <strong>"호텔 셔틀버스 시간표를 미리 파악해두면 매우 편리하다"</strong>는 점입니다.
</p>

${img(photo2, `${p.hotelName} 객실`, `객실 내부 · 실제 투숙 환경`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">🛏️ 객실 분위기 — 사진과의 차이 솔직 평가</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
객실 리뷰에서 <strong>침구 퀄리티</strong>에 대한 긍정적 언급이 많습니다.
반면 <strong>에어컨 소음</strong>은 층·방향에 따라 편차가 있어 주의가 필요합니다.
예약 시 "고층 + 도로에서 먼 방향"을 요청하면 조용한 환경을 확보할 가능성이 높아집니다.
욕실 어메니티는 대체로 만족스럽다는 평가가 많으며, 특히 뷰가 좋은 객실의 경우
<strong>아침에 커튼을 열었을 때의 감동</strong>을 언급하는 리뷰가 눈에 띄게 많습니다.
</p>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">🍳 조식 & 수영장 — 실제로 이용해보면</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
조식은 <strong>메뉴 다양성과 로컬 요리 구성</strong>에 대한 긍정적 평가가 많습니다.
오전 7시 초반에 방문하면 혼잡 없이 여유롭게 즐길 수 있으며,
8~9시 성수기 피크 타임에는 좌석 경쟁이 생길 수 있습니다.
수영장은 <strong>그늘 자리 확보</strong>가 관건입니다. 오전 일찍 타월을 가져다 두는 것이 팁입니다.
키즈풀 분리 여부는 가족 여행자에게 특히 중요한 체크 포인트입니다.
</p>

${img(photo3, `${p.hotelName} 수영장·부대시설`, `수영장 · 조식당 · 부대시설`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">😕 아쉬운 점 — 투숙 전 꼭 알아야 할 것들</h2>
<ul style="margin:12px 0 16px 22px;line-height:2.3;font-size:16px;color:#374151;">
  <li>성수기 조식·체크인 혼잡 — 비수기 여행자는 해당 없음</li>
  <li>일부 객실 에어컨 소음 — 층·방향 요청으로 개선 가능</li>
  <li>리조트 피·주차비 등 추가 요금 발생 가능 — 예약 전 확인 필수</li>
  <li>공항↔호텔 이동 비용 예상보다 높을 수 있음 — 셔틀 시간표 미리 확인</li>
</ul>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">👥 이런 여행자에게 맞습니다</h2>
<p style="font-size:16px;color:#374151;line-height:1.9;">
<strong>✅ 강력 추천:</strong> 분위기·프라이버시 중시 커플, 효도 여행, 리조트 안에서 모든 것을 해결하고 싶은 여행자, 비즈니스 출장자<br/>
<strong>❌ 비추천:</strong> 도심 접근성 최우선, 최저가만 추구, 활동적 관광 위주 일정, 호텔은 잠만 자는 배낭여행자
</p>

${cta(p.affiliateUrl, BTN_BLUE, "🏨 아고다에서 날짜별 객실 가격 비교하기")}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
  <summary style="padding:15px 18px;font-weight:700;cursor:pointer;background:#f8fafc;font-size:15px;">Q. ${f.q}</summary>
  <div style="padding:15px 18px;font-size:15px;line-height:1.8;color:#374151;background:#fff;">A. ${f.a}</div>
</details>`).join("")}
${faqSchema(faqs)}
${cta(p.affiliateUrl, BTN_GREEN, "📅 최저가로 예약하기 →")}

<p style="font-size:13px;color:#9ca3af;margin-top:16px;">
#${p.hotelName.replace(/\s+/g,"")} #호텔후기 #아고다리뷰 #실투숙후기 #${p.keyword.replace(/\s+/g,"")} #숙소후기 #아고다 #여행리뷰
</p>`
}

// ─── compare 빌더 ──────────────────────────────
function buildCompareHtml(p: Parameters<typeof buildHybridHtml>[0] & {compareHotelName?:string}) {
  const compare = p.compareHotelName || "동급 대체 숙소"
  const heroSrc = p.photos[0]||FALLBACK
  const faqs = [
    {q:`${p.hotelName}과 ${compare} 중 어디가 더 낫나요?`, a:`목적에 따라 다릅니다. 분위기·프라이버시 중시라면 ${p.hotelName}, 가성비·교통 접근성이라면 ${compare}를 추천합니다.`},
    {q:`두 호텔의 가격 차이는 어느 정도인가요?`, a:`성수기/비수기, 날짜에 따라 크게 달라집니다. 날짜를 ±2일 이동하며 아고다 총액 기준으로 비교하는 것이 가장 정확합니다.`},
    {q:`가족 여행이라면 어느 쪽이 더 적합한가요?`, a:`키즈존 분리, 패밀리룸 구성, 조식 편의성 면에서 각 호텔 최신 리뷰를 확인하는 것을 권장합니다.`},
  ]
  return `${img(heroSrc, `${p.hotelName} vs ${compare} 비교`, `${p.hotelName} · ${p.location||""}`)}

<h1 style="font-size:clamp(22px,3vw,28px);font-weight:800;line-height:1.35;letter-spacing:-.5px;margin-bottom:16px;">${p.hotelName} vs ${compare} — ${p.keyword} 어디로 예약해야 할까? (${new Date().getFullYear()}년 최신 비교)</h1>

<p style="font-size:16px;color:#374151;line-height:1.9;margin-bottom:20px;">
<strong>"둘 다 괜찮아 보이는데 어디가 더 나을까?"</strong> ${p.keyword}를 검색하다 보면 항상 마주치는 고민입니다.
이 글은 <strong>${p.hotelName}과 ${compare}를 위치·가격·객실·시설·서비스 5가지 기준</strong>으로 직접 비교하고,
어떤 여행자에게 어떤 호텔이 더 맞는지 명확하게 정리했습니다.
세금 포함 총액 기준 가격 비교부터 실투숙자 후기 분석까지, 예약 결정에 필요한 모든 정보를 담았습니다.
</p>

${cta(p.affiliateUrl, BTN_RED, `👉 ${p.hotelName} 현재 가격 확인`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">⚡ 한눈에 보는 비교 요약</h2>
<table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0;border-radius:12px;overflow:hidden;">
  <thead><tr style="background:#0B3D91;color:#fff;">
    <th style="padding:14px 16px;text-align:left;font-weight:700;">비교 항목</th>
    <th style="padding:14px 16px;text-align:center;font-weight:700;">${p.hotelName}</th>
    <th style="padding:14px 16px;text-align:center;font-weight:700;">${compare}</th>
  </tr></thead>
  <tbody>
    <tr style="background:#f8fafc;"><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">위치·접근성</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">아고다 확인</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">아고다 확인</td></tr>
    <tr><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">아고다 평점</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;font-weight:700;color:#0B3D91;">${p.score||"–"}/10</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">날짜별 확인</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">가격대 (기준)</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">날짜별 상이</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">날짜별 상이</td></tr>
    <tr><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">조식 포함</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">옵션 선택</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">옵션 선택</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">수영장</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">리뷰 확인</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">리뷰 확인</td></tr>
    <tr><td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;">무료 취소</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">날짜별 확인</td><td style="padding:12px 16px;border:1px solid #e2e8f0;text-align:center;">날짜별 확인</td></tr>
  </tbody>
</table>

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">👥 여행자 유형별 최종 선택 가이드</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0;">
  <div style="background:#eff6ff;border:1.5px solid #93c5fd;border-radius:12px;padding:16px;">
    <p style="font-weight:800;color:#1B56C5;margin-bottom:10px;font-size:15px;">${p.hotelName} 선택 시</p>
    <ul style="margin:0 0 0 18px;font-size:14px;line-height:2.1;color:#374151;">
      <li>허니문·커플 분위기 중시</li>
      <li>리조트 올인클루시브 선호</li>
      <li>평점·서비스 품질 우선</li>
    </ul>
  </div>
  <div style="background:#faf5ff;border:1.5px solid #d8b4fe;border-radius:12px;padding:16px;">
    <p style="font-weight:800;color:#7c3aed;margin-bottom:10px;font-size:15px;">${compare} 선택 시</p>
    <ul style="margin:0 0 0 18px;font-size:14px;line-height:2.1;color:#374151;">
      <li>도심 접근성 최우선</li>
      <li>예산 절약 후 액티비티 투자</li>
      <li>이동 많은 관광형 일정</li>
    </ul>
  </div>
</div>

${cta(p.affiliateUrl, BTN_BLUE, `🏨 ${p.hotelName} 날짜별 가격 비교`)}

<h2 style="font-size:20px;font-weight:700;margin:32px 0 12px;">❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
  <summary style="padding:15px 18px;font-weight:700;cursor:pointer;background:#f8fafc;font-size:15px;">Q. ${f.q}</summary>
  <div style="padding:15px 18px;font-size:15px;line-height:1.8;color:#374151;background:#fff;">A. ${f.a}</div>
</details>`).join("")}
${faqSchema(faqs)}
${cta(p.affiliateUrl, BTN_GREEN, `📅 ${p.hotelName} 최저가로 예약하기 →`)}
<p style="font-size:13px;color:#9ca3af;margin-top:16px;">#${p.keyword.replace(/\s+/g,"")} #호텔비교 #아고다 #숙소선택 #여행팁</p>`
}

// ─── 제목 패턴 ─────────────────────────────────
function buildTitle(hotelName:string,keyword:string,ft:FormatType,pattern?:number):string {
  const year = new Date().getFullYear()
  const P: Record<FormatType,string[]> = {
    hybrid:[
      `${year} ${hotelName} 리뷰 | 위치·객실·조식·가격 총정리`,
      `${keyword} 완벽 가이드 — 후기 기반 핵심 정리`,
      `${hotelName} 숙박 체크포인트 | 예약 전 꼭 읽어야 할 분석`,
      `${year} ${keyword} — 장단점·예약 전략 총정리`,
      `${hotelName} 가격 분석 | 세금 포함 총액·무료취소 완벽 정리`,
      `${keyword} BEST — ${hotelName} 선택 전 알아야 할 모든 것`,
    ],
    review:[
      `${hotelName} 솔직 후기 — 실제로 묵어보면 이런 느낌입니다`,
      `${year} ${keyword} 체험 리뷰 | 장점·단점·꿀팁 총정리`,
      `${hotelName} 직접 투숙 후기 — 기대와 현실의 차이`,
      `${keyword} 실투숙 리뷰 | 조식·수영장·객실 솔직 평가`,
      `${hotelName} 후기 | 허니문·가족·비즈니스 각각 어떨까?`,
      `"묵어봤습니다" ${hotelName} — 예약 전 꼭 읽어야 할 리뷰`,
    ],
    compare:[
      `${hotelName} vs 대체 숙소 — ${keyword} 어디로 예약할까?`,
      `${year} ${keyword} 비교 | ${hotelName} 선택 기준 완전 분석`,
      `${hotelName} 직접 비교 — 가격·위치·객실 3가지 기준으로`,
      `${keyword} 선택 가이드 | ${hotelName}이 정답인 여행자 유형`,
      `${hotelName} vs 경쟁 호텔 — 어떤 여행자에게 더 나을까?`,
      `${year} ${keyword} | ${hotelName} 예약 전 반드시 비교할 것들`,
    ],
  }
  const list = P[ft]||P.hybrid
  const idx  = typeof pattern==="number" ? pattern%list.length : Math.floor(Math.random()*list.length)
  return list[idx]
}

// ─── city_id 조회 ──────────────────────────────
const CITY_JSON_URL = "https://raw.githubusercontent.com/sj04236-droid/agoda-wp-automation/main/city-ids-worldwide.json"
let cityCache: Record<string,number>|null = null
let cacheTime = 0
const KR_TO_EN: Record<string,string> = {
  "서울":"seoul","부산":"busan","제주":"jeju","강릉":"gangneung-si",
  "도쿄":"tokyo","오사카":"osaka","후쿠오카":"fukuoka","교토":"kyoto",
  "방콕":"bangkok","푸켓":"phuket","치앙마이":"chiang mai",
  "발리":"bali","다낭":"da nang","호치민":"ho chi minh city",
  "싱가포르":"singapore","홍콩":"hong kong","파리":"paris","런던":"london",
  "괌":"tamuning","하와이":"honolulu","몰디브":"maldives",
}
async function getCityId(name:string): Promise<number|null> {
  if (!name) return null
  if (!cityCache || Date.now()-cacheTime > 3600000) {
    try { const r = await fetch(CITY_JSON_URL); cityCache=await r.json(); cacheTime=Date.now() }
    catch { cityCache=cityCache||{} }
  }
  const q=name.toLowerCase().trim(), en=KR_TO_EN[q]||q
  const map=cityCache!
  if(map[en]) return map[en]
  if(map[q])  return map[q]
  for(const [k,v] of Object.entries(map)) if(k.startsWith(en)||en.startsWith(k)) return v
  return null
}

// ─── 메인 핸들러 ───────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const hKey = safeStr(req.headers.get("x-api-key"))
    if (!getApiKey()||hKey!==getApiKey()) return unauthorized()

    let body:any={}
    try { body=await req.json() } catch { return badRequest("Invalid JSON") }

    const keyword          = safeStr(body.keyword);  if(!keyword)  return badRequest("keyword required")
    const hotelId          = safeStr(body.hotelId);  if(!hotelId)  return badRequest("hotelId required")
    const cityNameInput    = safeStr(body.cityName)
    const formatType       = (safeStr(body.formatType)||"hybrid") as FormatType
    const publishType      = (safeStr(body.publishType)||"draft") as PublishType
    const category         = typeof body.category==="number" ? body.category : undefined
    const compareHotelName = safeStr(body.compareHotelName)
    const titlePattern     = typeof body.titlePattern==="number" ? body.titlePattern : undefined

    if(!["hybrid","review","compare"].includes(formatType)) return badRequest("formatType: hybrid|review|compare")

    // Agoda 호텔 정보 조회
    const agodaData = await agodaGetHotelById(hotelId)
    const first     = agodaData?.results?.[0] || agodaData
    const hotelName = safeStr(first?.hotelName)||safeStr(first?.propertyName)||keyword
    const score     = typeof first?.reviewScore==="number" ? first.reviewScore.toFixed(1) : undefined
    const reviews   = typeof first?.reviewCount==="number" ? String(first.reviewCount) : undefined
    const cityName  = cityNameInput||safeStr(first?.cityName)
    const location  = [cityName, safeStr(first?.countryName)].filter(Boolean).join(", ")||undefined
    const checkin   = safeStr(first?.checkin)
    const checkout  = safeStr(first?.checkout)
    const starRating = typeof first?.starRating==="number" ? first.starRating : undefined

    // ★ 사진 URL 배열 (최대 5장) — WP 업로드 없이 URL 그대로 사용
    const photos: string[] = [
      first?.imageURL,
      first?.photo1, first?.photo2, first?.photo3, first?.photo4, first?.photo5,
    ].filter((u): u is string => typeof u==="string" && u.length>0)
      .slice(0,5)
    if(!photos.length) photos.push(FALLBACK)

    // city_id 자동 조회
    const cityId  = cityName ? await getCityId(cityName) : null
    const cid     = safeStr(process.env.AGODA_AFFILIATE_CID)||"1959499"
    const cityUrl = cityId
      ? `https://www.agoda.com/ko-kr/search?city=${cityId}&cid=${cid}&currency=KRW`
      : undefined
    const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(hotelId)}&cid=${encodeURIComponent(cid)}&hl=ko-kr&rooms=1&adults=2`

    // 본문 생성
    const params = { hotelName,affiliateUrl,keyword,cityUrl,photos,score,reviews,location,checkin,checkout,starRating,compareHotelName }
    let html: string
    switch(formatType) {
      case "review":  html=buildReviewHtml(params);  break
      case "compare": html=buildCompareHtml(params); break
      default:        html=buildHybridHtml(params);  break
    }
    html += hotelSchema(hotelName,location||"",score||"",reviews||"0")

    const title          = buildTitle(hotelName,keyword,formatType,titlePattern)
    const seoTitle       = safeStr(body.seoTitle)||title
    const seoDescription = safeStr(body.seoDescription)||`${hotelName} ${location||""}. 실투숙자 리뷰, 위치·객실·조식·가격 전략, 아고다 최저가 예약 방법 총정리.`
    const focusKeyword   = safeStr(body.focusKeyword)||keyword
    const slug           = safeStr(body.slug)||keyword.toLowerCase().replace(/[^\w\s-]/g,"").replace(/\s+/g,"-").slice(0,60)

    const wp = await wpCreatePost({title,content:html,status:publishType,category,slug,seoTitle,seoDescription,focusKeyword})

    return json({
      success: true,
      format:  formatType,
      resolved: {
        keyword, hotelId, hotelName, title,
        cityName, cityId, location,
        affiliateUrl, cityUrl,
        // ★ GPTs에서 이미지 표시용 URL 반환
        photos,
        heroImageUrl: photos[0],
        score, reviews, starRating, checkin, checkout,
      },
      wp,
    })
  } catch(e:any) {
    return NextResponse.json({ error:e?.message||String(e) },{ status:500 })
  }
}
