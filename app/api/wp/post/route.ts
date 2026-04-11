// app/api/wp/post/route.ts — V3.2
// 신규: cityName → city-ids-worldwide.json 자동 조회 → cityId + cityUrl 자동 생성

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

// ─── city_id 조회 (GitHub JSON) ────────────────
const CITY_JSON_URL = "https://raw.githubusercontent.com/sj04236-droid/agoda-wp-automation/main/city-ids-worldwide.json"
let cityCache: Record<string, number> | null = null
let cacheTime = 0

// 한글 → 영문 매핑
const KR_TO_EN: Record<string, string> = {
  "서울":"seoul","부산":"busan","제주":"jeju","강릉":"gangneung-si",
  "경주":"gyeongju-si","여수":"yeosu-si","인천":"incheon","대구":"daegu",
  "대전":"daejeon","광주":"gwangju metropolitan city","속초":"sokcho-si",
  "도쿄":"tokyo","동경":"tokyo","오사카":"osaka","후쿠오카":"fukuoka",
  "교토":"kyoto","삿포로":"sapporo","오키나와":"naha",
  "방콕":"bangkok","푸켓":"phuket","치앙마이":"chiang mai","파타야":"pattaya",
  "코사무이":"koh samui",
  "다낭":"da nang","하노이":"hanoi","호치민":"ho chi minh city",
  "나트랑":"nha trang","푸꾸옥":"phu quoc",
  "발리":"bali","우붓":"ubud","스미냑":"seminyak","짱구":"canggu",
  "세부":"cebu","보라카이":"boracay","마닐라":"manila","엘니도":"el nido",
  "싱가포르":"singapore","홍콩":"hong kong","타이베이":"taipei",
  "상하이":"shanghai","마카오":"macau",
  "파리":"paris","런던":"london","로마":"rome","바르셀로나":"barcelona",
  "괌":"tamuning","사이판":"saipan","하와이":"honolulu",
  "몰디브":"maldives","시드니":"sydney",
}

async function getCityId(cityName: string): Promise<number | null> {
  if (!cityName) return null
  // 캐시 로드
  if (!cityCache || Date.now() - cacheTime > 3600000) {
    try {
      const res = await fetch(CITY_JSON_URL)
      cityCache = await res.json()
      cacheTime = Date.now()
    } catch { cityCache = cityCache || {} }
  }
  const map = cityCache!
  const q   = cityName.toLowerCase().trim()
  const en  = KR_TO_EN[q] || q
  if (map[en])  return map[en]
  if (map[q])   return map[q]
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(en) || en.startsWith(k)) return v
  }
  for (const [k, v] of Object.entries(map)) {
    if (k.includes(en) || en.includes(k)) return v
  }
  return null
}

// ─── Agoda API ─────────────────────────────────
async function agodaGetHotelById(hotelId: string) {
  const auth = process.env.AGODA_AUTH || ""
  let siteId = process.env.AGODA_SITE_ID || "1959499"
  let apiKey  = process.env.AGODA_API_KEY  || "24680cfc-3bff-4410-845d-5cb97d854532"
  if (auth.includes(":")) {
    const parts = auth.split(":")
    if (parts.length === 3 && parts[0] === parts[1]) {
      siteId = parts[0]; apiKey = parts[2]
    } else {
      siteId = parts[0]; apiKey = parts.slice(1).join(":")
    }
  }
  const body = {
    criteria: {
      checkInDate: getFutureDate(7), checkOutDate: getFutureDate(10),
      hotelId: [Number(hotelId)],
      additional: { currency:"KRW", language:"ko-kr", discountOnly:false,
        occupancy: { numberOfAdult:2, numberOfChildren:0 } },
    },
  }
  const res  = await fetch("http://affiliateapi7643.agoda.com/affiliateservice/lt_v1", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Accept-Encoding":"gzip,deflate",
      "Authorization": `${siteId}:${apiKey}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

// ─── WP 이미지 업로드 ──────────────────────────
async function wpUploadImage(imageUrl: string, hotelId: string): Promise<number | null> {
  const WP_URL  = safeStr(process.env.WP_URL)
  const WP_USER = safeStr(process.env.WP_USERNAME)
  const WP_PASS = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)
  if (!WP_URL || !WP_USER || !WP_PASS) return null
  try {
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error("Image fetch failed")
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const ct     = imgRes.headers.get("content-type") || "image/jpeg"
    const ext    = ct.includes("png") ? "png" : "jpg"
    const token  = Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")
    const mRes   = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: { Authorization:`Basic ${token}`,
        "Content-Disposition":`attachment; filename="agoda-${hotelId}-${Date.now()}.${ext}"`,
        "Content-Type":ct },
      body: imgBuf,
    })
    if (mRes.ok) { const m = await mRes.json(); return m.id as number }
  } catch(e) { console.warn("이미지 업로드 실패:", e) }
  return null
}

// ─── WP 포스트 발행 ────────────────────────────
async function wpCreatePost(params: {
  title:string; content:string; status:PublishType
  category?:number; featuredMediaId?:number|null; slug?:string
  seoTitle?:string; seoDescription?:string; focusKeyword?:string
}) {
  const WP_URL  = safeStr(process.env.WP_URL)
  const WP_USER = safeStr(process.env.WP_USERNAME)
  const WP_PASS = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)
  if (!WP_URL) throw new Error("WP_URL missing")
  const token = Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")
  const body: any = {
    title: params.title, content: params.content, status: params.status,
    ...(params.category && { categories: [params.category] }),
    ...(params.slug     && { slug: params.slug }),
    ...(params.featuredMediaId && { featured_media: params.featuredMediaId }),
    meta: {
      rank_math_title:         params.seoTitle       || params.title,
      rank_math_description:   params.seoDescription || "",
      rank_math_focus_keyword: params.focusKeyword   || "",
    },
  }
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { Authorization:`Basic ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ─── 스타일 상수 ───────────────────────────────
const BTN_RED   = `background:#ff5a5f;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const BTN_BLUE  = `background:#1B56C5;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const BTN_GREEN = `background:#16a34a;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const FALLBACK_IMG = "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80"

function heroImg(src: string, alt: string) {
  return `<figure style="margin:0 0 24px 0;"><img src="${src}" alt="${alt}" onerror="this.src='${FALLBACK_IMG}'" style="width:100%;max-height:480px;object-fit:cover;border-radius:14px;"/></figure>`
}
function ctaBtn(url: string, style: string, text: string) {
  return `<div style="margin:24px 0;text-align:center;"><a href="${url}" target="_blank" rel="nofollow noopener" style="${style}">${text}</a><p style="font-size:12px;color:#6b7280;margin-top:6px;">※ 아고다 제휴 링크 · 동일 최저가 보장</p></div>`
}
function faqSchema(faqs: {q:string,a:string}[]) {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":${JSON.stringify(faqs.map(f=>({
    "@type":"Question","name":f.q,"acceptedAnswer":{"@type":"Answer","text":f.a}
  })))}}</script>`
}
function hotelSchema(name:string, addr:string, score:string) {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Hotel","name":"${name}","address":"${addr}","aggregateRating":{"@type":"AggregateRating","ratingValue":"${score}","reviewCount":"0"}}</script>`
}

// ─── HTML 빌더 (hybrid) ────────────────────────
function buildHybridHtml(p: {hotelName:string;affiliateUrl:string;keyword:string;cityUrl?:string;heroImageUrl?:string;score?:string;location?:string}) {
  const img = heroImg(p.heroImageUrl||FALLBACK_IMG, `${p.hotelName} — 아고다 최저가`)
  const cityLink = p.cityUrl ? `<a href="${p.cityUrl}" target="_blank" rel="noopener" style="color:#1B56C5;font-weight:700;">${p.location||"해당 도시"} 호텔 전체 보기 →</a>` : ""
  const faqs = [
    {q:`${p.hotelName}의 아고다 평점은?`, a:`아고다 기준 ${p.score||"예약 페이지 확인"}점이며, 실시간 가격은 날짜에 따라 달라집니다.`},
    {q:`조식 포함 옵션이 유리한가요?`, a:`1박당 조식 차액을 총액 기준으로 비교하세요. 성인 2명 이상이면 포함 옵션이 유리할 때가 많습니다.`},
    {q:`무료취소 옵션만 보고 예약해도 되나요?`, a:`무료취소 "마감 날짜+시간"과 부분 환불 조건을 결제 전 반드시 확인하세요.`},
    {q:`날짜를 바꾸면 가격이 달라지나요?`, a:`체크인 날짜를 1~2일 이동하면 가격이 크게 달라질 수 있습니다.`},
  ]
  return `${img}
<h1>${p.keyword} 완벽 가이드 — ${p.hotelName} 후기·가격·예약 전략</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;">${p.keyword} 검색 시 가장 중요한 건 "가격 대비 실제 만족도"입니다. 이 글은 <strong>실투숙자 리뷰 포인트</strong>를 기준으로 객실·조식·수영장·동선·추가요금 관점에서 선택 기준을 정리한 <strong>통합 가이드</strong>입니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, "👉 아고다 최저가 지금 확인하기")}
${cityLink ? `<p style="margin:12px 0;">${cityLink}</p>` : ""}
<div style="background:#f0f7ff;border-left:4px solid #1B56C5;padding:16px 20px;border-radius:8px;margin:20px 0;">
  <p style="font-weight:700;font-size:15px;margin:0 0 4px;">📍 ${p.hotelName} 핵심 정보</p>
  <p style="font-size:13px;color:#374151;margin:0;">위치: ${p.location||"예약 페이지 확인"} · 평점: ${p.score||"–"}/10 · 비교 기준: 세금/봉사료 포함 총액</p>
</div>
<h2>✅ 실투숙자 후기에서 반복되는 장점</h2>
<p>위치 편의성, 청결도, 직원 친절함이 반복적으로 높은 평가를 받습니다. "기대보다 좋았다"는 표현이 자주 등장한다는 점은 가격 대비 만족도가 높다는 신호입니다.</p>
<h2>⚠️ 후기에서 나오는 아쉬운 점</h2>
<p>성수기 조식 혼잡, 특정 층 소음, 객실 컨디션 편차가 반복 언급됩니다. 예약 시 층수·동 요청을 구체적으로 남기면 편차를 줄일 수 있습니다.</p>
<h2>🛏️ 객실 선택 가이드</h2>
<ul style="margin:12px 0 0 20px;line-height:2;">
  <li><strong>가족 여행</strong>: 킹/트윈 구성, 아동 추가 요금, 소파베드 유무 확인</li>
  <li><strong>커플·허니문</strong>: 오션/가든 뷰 + 발코니 + 프라이버시 우선</li>
  <li><strong>부모님 동반</strong>: 엘리베이터·조식당 동선 + 저층 소음 여부 체크</li>
</ul>
<h2>🍳 조식 & 수영장 핵심 체크</h2>
<p>조식은 <strong>7~8시 초반</strong>에 가면 혼잡을 피할 수 있습니다. 조식 포함 여부는 <strong>총액 기준</strong>으로 비교하세요.</p>
<h2>👥 추천 / 비추천</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0;">
  <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px;">
    <strong style="color:#16a34a;">✅ 추천</strong>
    <ul style="margin:8px 0 0 16px;font-size:14px;line-height:1.9;"><li>허니문·커플 여행</li><li>리조트 올인클루시브 선호</li><li>비즈니스 출장자</li></ul>
  </div>
  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;">
    <strong style="color:#dc2626;">❌ 비추천</strong>
    <ul style="margin:8px 0 0 16px;font-size:14px;line-height:1.9;"><li>도심 교통 접근성 최우선</li><li>극가성비 예산 여행자</li></ul>
  </div>
</div>
<h2>💰 가격 전략: 손해 줄이는 5단계</h2>
<ol style="margin:12px 0 0 20px;line-height:2;">
  <li>체크인 날짜 <strong>±1~2일 이동</strong>하며 총액 비교</li>
  <li>무료취소 마감 <strong>"날짜+시간"</strong> 정확히 확인</li>
  <li>세금·봉사료 포함 <strong>총액 기준</strong>으로 비교</li>
  <li>조식 포함은 <strong>인원수 기준</strong> 유불리 계산</li>
  <li>연박이면 <strong>분할 예약</strong>도 고려</li>
</ol>
${ctaBtn(p.affiliateUrl, BTN_BLUE, "🏨 객실 옵션 & 총액 비교하기")}
<h2>❓ 자주 묻는 질문 (FAQ)</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, "📅 최저가로 지금 예약하기 →")}
<h2>🏷 관련 태그</h2>
<p style="font-size:13px;color:#6b7280;">#${p.keyword.replace(/\s+/g,"")} #아고다 #호텔예약 #숙소추천 #여행팁</p>`
}

// ─── review / compare 빌더는 hybrid와 구조 동일, 내용만 다름 ───
function buildReviewHtml(p: Parameters<typeof buildHybridHtml>[0]) {
  const img = heroImg(p.heroImageUrl||FALLBACK_IMG, `${p.hotelName} 실투숙 리뷰`)
  const faqs = [
    {q:`${p.hotelName}, 실제로 묵어볼 만한가요?`, a:`청결도·직원 서비스·위치 항목에서 꾸준히 높은 점수를 받고 있습니다.`},
    {q:`가장 많이 언급되는 단점은?`, a:`성수기 조식 대기, 일부 객실 소음이 반복 언급됩니다. 층·동 요청으로 개선 가능합니다.`},
    {q:`커플·허니문에 적합한가요?`, a:`분위기와 프라이버시를 중시하는 커플에게 적합합니다.`},
  ]
  return `${img}
<h1>${p.hotelName} 솔직 후기 — 실제로 묵어보면 이런 느낌입니다</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;"><strong>"사진과 얼마나 다를까?"</strong> 이 글은 리뷰 데이터를 기반으로 <strong>실제 투숙자들이 공통적으로 느낀 것</strong>을 체감 중심으로 정리했습니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, "👉 아고다에서 현재 가격 확인")}
<h2>🚪 첫인상</h2><p>체크인 카운터까지의 동선은 짧고 안내 직원이 배치되어 있어 <strong>첫 인상은 긍정적</strong>이라는 평가가 대부분입니다.</p>
<h2>📍 위치 체감</h2><p>지도상 위치보다 <strong>실제 도보 체감</strong>이 중요합니다. 셔틀버스 시간을 미리 파악해두면 편리합니다.</p>
<h2>🛏️ 객실 분위기</h2><p>침구 퀄리티와 에어컨 소음이 반복 언급됩니다. <strong>고층 + 조용한 방향 요청</strong>으로 편차를 줄일 수 있습니다.</p>
<h2>🍳 조식 체감</h2><p>성수기 8~9시는 혼잡합니다. <strong>7시 초반 방문</strong>을 추천합니다.</p>
<h2>😕 아쉬운 점</h2>
<ul style="margin:12px 0 0 20px;line-height:2;">
  <li>성수기 조식·체크인 혼잡</li><li>일부 객실 에어컨 소음</li><li>공항↔호텔 이동비 추가 발생 가능</li>
</ul>
${ctaBtn(p.affiliateUrl, BTN_BLUE, "🏨 객실·날짜별 가격 비교하기")}
<h2>❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, "📅 최저가로 예약하기 →")}`
}

function buildCompareHtml(p: Parameters<typeof buildHybridHtml>[0] & {compareHotelName?:string}) {
  const compare = p.compareHotelName || "동급 대체 숙소"
  const img = heroImg(p.heroImageUrl||FALLBACK_IMG, `${p.hotelName} vs ${compare}`)
  const faqs = [
    {q:`${p.hotelName}과 ${compare} 중 어디가 낫나요?`, a:`분위기 중시라면 ${p.hotelName}, 가성비·위치라면 ${compare}를 추천합니다.`},
    {q:`두 호텔의 가격 차이는?`, a:`성수기/비수기에 따라 크게 달라집니다. 날짜를 바꿔가며 아고다 총액으로 비교하세요.`},
  ]
  return `${img}
<h1>${p.hotelName} vs ${compare} — ${p.keyword} 어디로 예약할까?</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;">이 글은 <strong>${p.hotelName}과 ${compare}를 위치·가격·객실·시설 기준으로 비교</strong>해 어떤 여행자에게 무엇이 맞는지 정리했습니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, `👉 ${p.hotelName} 지금 가격 확인`)}
<h2>⚡ 비교 요약</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
  <thead><tr style="background:#1B56C5;color:#fff;"><th style="padding:12px;text-align:left;">항목</th><th style="padding:12px;">${p.hotelName}</th><th style="padding:12px;">${compare}</th></tr></thead>
  <tbody>
    <tr style="background:#f8fafc;"><td style="padding:10px;border:1px solid #e2e8f0;">위치</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">아고다 확인</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">아고다 확인</td></tr>
    <tr><td style="padding:10px;border:1px solid #e2e8f0;">평점</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">${p.score||"–"}/10</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">날짜별 확인</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:10px;border:1px solid #e2e8f0;">가격대</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">날짜별 상이</td><td style="padding:10px;border:1px solid #e2e8f0;text-align:center;">날짜별 상이</td></tr>
  </tbody>
</table>
${ctaBtn(p.affiliateUrl, BTN_BLUE, `🏨 ${p.hotelName} 날짜별 가격 비교`)}
<h2>❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, `📅 ${p.hotelName} 최저가로 예약 →`)}`
}

// ─── 제목 패턴 ─────────────────────────────────
function buildTitle(hotelName:string, keyword:string, ft:FormatType, pattern?:number): string {
  const year = new Date().getFullYear()
  const P: Record<FormatType, string[]> = {
    hybrid: [
      `${year} ${hotelName} 리뷰 | 위치·객실·조식·가격 총정리`,
      `${keyword} 완벽 가이드 — 후기 기반 핵심 정리`,
      `${hotelName} 숙박 체크포인트 | 예약 전 꼭 읽어야 할 분석`,
      `${year} ${keyword} — 장단점·예약 전략 총정리`,
      `${hotelName} 가격 분석 | 세금 포함 총액·무료취소 완벽 정리`,
      `${keyword} BEST — ${hotelName} 선택 전 알아야 할 모든 것`,
    ],
    review: [
      `${hotelName} 솔직 후기 — 실제로 묵어보면 이런 느낌입니다`,
      `${year} ${keyword} 체험 리뷰 | 장점·단점·꿀팁 총정리`,
      `${hotelName} 직접 투숙 후기 — 기대와 현실의 차이`,
      `${keyword} 실투숙 리뷰 | 조식·수영장·객실 솔직 평가`,
      `${hotelName} 후기 | 허니문·가족·비즈니스 각각 어떨까?`,
      `"묵어봤습니다" ${hotelName} 리뷰 — 예약 전 꼭 읽어야 할 체험담`,
    ],
    compare: [
      `${hotelName} vs 대체 숙소 — ${keyword} 어디로 예약할까?`,
      `${year} ${keyword} 비교 | ${hotelName} 선택 기준 완전 분석`,
      `${hotelName} 직접 비교 — 가격·위치·객실 3가지 기준으로`,
      `${keyword} 선택 가이드 | ${hotelName}이 정답인 여행자 유형`,
      `${hotelName} vs 경쟁 호텔 — 어떤 여행자에게 더 나을까?`,
      `${year} ${keyword} | ${hotelName} 예약 전 반드시 비교해야 할 것들`,
    ],
  }
  const list = P[ft] || P.hybrid
  const idx  = typeof pattern === "number" ? pattern % list.length : Math.floor(Math.random() * list.length)
  return list[idx]
}

// ─── 메인 핸들러 ───────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const headerKey = safeStr(req.headers.get("x-api-key"))
    if (!getApiKey() || headerKey !== getApiKey()) return unauthorized()

    let body: any = {}
    try { body = await req.json() } catch { return badRequest("Invalid JSON") }

    const keyword          = safeStr(body.keyword);  if (!keyword)  return badRequest("keyword required")
    const hotelId          = safeStr(body.hotelId);  if (!hotelId)  return badRequest("hotelId required")
    const cityNameInput    = safeStr(body.cityName)
    const formatType       = (safeStr(body.formatType) || "hybrid") as FormatType
    const publishType      = (safeStr(body.publishType) || "draft") as PublishType
    const category         = typeof body.category === "number" ? body.category : undefined
    const compareHotelName = safeStr(body.compareHotelName)
    const titlePattern     = typeof body.titlePattern === "number" ? body.titlePattern : undefined

    if (!["hybrid","review","compare"].includes(formatType)) return badRequest("formatType: hybrid|review|compare")

    // Agoda 호텔 정보
    const agodaData  = await agodaGetHotelById(hotelId)
    const first      = agodaData?.results?.[0] || agodaData
    const hotelName  = safeStr(first?.hotelName) || safeStr(first?.propertyName) || keyword
    const score      = typeof first?.reviewScore === "number" ? first.reviewScore.toFixed(1) : undefined
    const cityName   = cityNameInput || safeStr(first?.cityName)
    const countryName = safeStr(first?.countryName)
    const location   = [cityName, countryName].filter(Boolean).join(", ") || undefined
    const heroImgUrl = safeStr(first?.imageURL) ||
      `https://pix6.agoda.net/hotelImages/${hotelId.slice(0,3)}/${hotelId}/${hotelId}_main.jpg?s=1024x768`

    // ★ city_id 자동 조회 (GitHub JSON)
    const cityId = cityName ? await getCityId(cityName) : null

    const cid          = safeStr(process.env.AGODA_AFFILIATE_CID) || "1959499"
    const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(hotelId)}&cid=${encodeURIComponent(cid)}&hl=ko-kr&rooms=1&adults=2`
    // ★ 도시 전체 검색 링크 (city_id 기반)
    const cityUrl      = cityId
      ? `https://www.agoda.com/ko-kr/search?city=${cityId}&cid=${cid}&currency=KRW`
      : undefined

    const featuredMediaId = await wpUploadImage(heroImgUrl, hotelId)

    const title          = buildTitle(hotelName, keyword, formatType, titlePattern)
    const seoTitle       = safeStr(body.seoTitle)       || title
    const seoDescription = safeStr(body.seoDescription) || `${title.slice(0,30)}... 실투숙자 리뷰, 가격 전략, 아고다 최저가 예약 방법 총정리.`
    const focusKeyword   = safeStr(body.focusKeyword)   || keyword

    const params = { hotelName, affiliateUrl, keyword, cityUrl, heroImageUrl: heroImgUrl, score, location, compareHotelName }
    let html: string
    switch (formatType) {
      case "review":  html = buildReviewHtml(params);  break
      case "compare": html = buildCompareHtml(params); break
      default:        html = buildHybridHtml(params);  break
    }
    html += hotelSchema(hotelName, location||"", score||"")

    const slug = safeStr(body.slug) || keyword.toLowerCase().replace(/[^\w\s-]/g,"").replace(/\s+/g,"-").slice(0,60)
    const wp   = await wpCreatePost({ title, content:html, status:publishType, category, featuredMediaId, slug, seoTitle, seoDescription, focusKeyword })

    return json({
      success: true,
      format:  formatType,
      resolved: { keyword, hotelId, hotelName, title, cityName, cityId, affiliateUrl, cityUrl, heroImgUrl },
      wp,
    })
  } catch(e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
