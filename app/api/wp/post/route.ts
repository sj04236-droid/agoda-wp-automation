import { NextRequest, NextResponse } from "next/server"

/**
 * ✅ 환경변수 (Vercel → Settings → Environment Variables)
 * API_KEY / INTERNAL_API_KEY : x-api-key 헤더 검증
 * WP_URL, WP_USERNAME, WP_APP_PASSWORD
 * AGODA_SITE_ID, AGODA_API_KEY, AGODA_AFFILIATE_CID
 */

type PublishType = "draft" | "publish"
type FormatType  = "hybrid" | "review" | "compare"

function safeStr(v: any): string { return typeof v === "string" ? v : "" }
function json(res: any, status = 200) { return NextResponse.json(res, { status }) }
function unauthorized() { return json({ error: "Unauthorized" }, 401) }
function badRequest(msg: string) { return json({ error: msg }, 400) }
function getInternalApiKey() {
  return safeStr(process.env.API_KEY) || safeStr(process.env.INTERNAL_API_KEY) || ""
}
function getFutureDate(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

// ─── Agoda API ─────────────────────────────────────
async function agodaGetHotelById(hotelId: string) {
  const SITE_ID = safeStr(process.env.AGODA_SITE_ID) || "1959499"
  const API_KEY = safeStr(process.env.AGODA_API_KEY)  || "24680cfc-3bff-4410-845d-5cb97d854532"
  const body = {
    criteria: {
      checkInDate:  getFutureDate(7),
      checkOutDate: getFutureDate(10),
      hotelId: [Number(hotelId)],
      additional: {
        currency: "KRW", language: "ko-kr", discountOnly: false,
        occupancy: { numberOfAdult: 2, numberOfChildren: 0 },
      },
    },
  }
  const res  = await fetch("http://affiliateapi7643.agoda.com/affiliateservice/lt_v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip,deflate",
      "Authorization": `${SITE_ID}:${API_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

// ─── WP 이미지 업로드 ──────────────────────────────
async function wpUploadImage(imageUrl: string, hotelId: string): Promise<number | null> {
  const WP_URL  = safeStr(process.env.WP_URL)
  const WP_USER = safeStr(process.env.WP_USERNAME)
  const WP_PASS = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)
  if (!WP_URL || !WP_USER || !WP_PASS) return null
  try {
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error("Image fetch failed")
    const imgBuf     = Buffer.from(await imgRes.arrayBuffer())
    const ct         = imgRes.headers.get("content-type") || "image/jpeg"
    const ext        = ct.includes("png") ? "png" : "jpg"
    const fileName   = `agoda-${hotelId}-${Date.now()}.${ext}`
    const token      = Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")
    const mediaRes   = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: { Authorization: `Basic ${token}`, "Content-Disposition": `attachment; filename="${fileName}"`, "Content-Type": ct },
      body: imgBuf,
    })
    if (mediaRes.ok) { const m = await mediaRes.json(); return m.id as number }
  } catch(e) { console.warn("이미지 업로드 실패:", e) }
  return null
}

// ─── WP 포스트 발행 ────────────────────────────────
async function wpCreatePost(params: {
  title: string; content: string; status: PublishType
  category?: number; featuredMediaId?: number | null; slug?: string
  seoTitle?: string; seoDescription?: string; focusKeyword?: string
}) {
  const WP_URL  = safeStr(process.env.WP_URL)
  const WP_USER = safeStr(process.env.WP_USERNAME)
  const WP_PASS = safeStr(process.env.WP_APP_PASSWORD) || safeStr(process.env.WP_PASSWORD)
  if (!WP_URL)  throw new Error("WP_URL missing")
  if (!WP_USER) throw new Error("WP_USERNAME missing")
  if (!WP_PASS) throw new Error("WP_APP_PASSWORD missing")
  const token  = Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")
  const body: any = {
    title: params.title, content: params.content, status: params.status,
    ...(params.category     && { categories: [params.category] }),
    ...(params.slug         && { slug: params.slug }),
    ...(params.featuredMediaId && { featured_media: params.featuredMediaId }),
    meta: {
      rank_math_title:         params.seoTitle       || params.title,
      rank_math_description:   params.seoDescription || "",
      rank_math_focus_keyword: params.focusKeyword   || "",
    },
  }
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { Authorization: `Basic ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ─── 공통 스타일 상수 ──────────────────────────────
const BTN_RED   = `background:#ff5a5f;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const BTN_BLUE  = `background:#1B56C5;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const BTN_GREEN = `background:#16a34a;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;font-size:16px;`
const FALLBACK_IMG = "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1200&q=80"

function heroImgBlock(src: string, alt: string) {
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
function hotelSchema(name: string, addr: string, score: string, reviewCount: string) {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Hotel","name":"${name}","address":"${addr}","aggregateRating":{"@type":"AggregateRating","ratingValue":"${score}","reviewCount":"${reviewCount}"}}</script>`
}

// ─── 발행 전 유효성 검사 ───────────────────────────
function validateOutput(html: string, title: string, seoTitle: string, seoDesc: string) {
  const warnings: string[] = []
  const ctaCount = (html.match(/아고다.*?(확인|예약|바로가기)/g) || []).length
  if (ctaCount < 3)           warnings.push(`CTA 버튼이 ${ctaCount}개입니다 (최소 3개 권장)`)
  if (!html.includes("FAQPage")) warnings.push("FAQ Schema.org 마크업이 없습니다")
  if (title.length > 50)      warnings.push(`제목이 ${title.length}자로 너무 깁니다 (45자 이하 권장)`)
  if (seoTitle && seoTitle.length > 60) warnings.push("seoTitle이 60자를 초과합니다")
  if (seoDesc && (seoDesc.length < 80 || seoDesc.length > 120)) warnings.push("seoDescription이 80~120자 권장 범위 밖입니다")
  const hotelIdMatch = html.match(/Hotel\s+\d{5,}/i)
  if (hotelIdMatch)           warnings.push(`본문에 hotel ID 노출 가능성: "${hotelIdMatch[0]}"`)
  return warnings
}

// ══════════════════════════════════════════════
// A. 정보형 + 리뷰형 (hybrid) — SEO + 전환 균형
// ══════════════════════════════════════════════
function buildHybridHtml(p: {
  hotelName: string; affiliateUrl: string; keyword: string
  heroImageUrl?: string; score?: string; location?: string
}) {
  const img = heroImgBlock(p.heroImageUrl || FALLBACK_IMG, `${p.hotelName} — 아고다 최저가`)
  const faqs = [
    {q:`${p.hotelName}의 아고다 평점은 얼마인가요?`, a:`아고다 기준 ${p.score||"예약 페이지 확인"} 점이며, 실시간 가격과 재고는 날짜에 따라 달라집니다.`},
    {q:`조식 포함 옵션이 유리한가요?`, a:`1박당 조식 차액을 총액 기준으로 비교하는 게 정답입니다. 성인 2명 이상이라면 포함 옵션이 유리할 때가 많습니다.`},
    {q:`무료취소 옵션만 보고 예약해도 되나요?`, a:`무료취소는 안전장치지만 "마감 날짜+시간"과 부분 환불 조건이 다를 수 있어 결제 전 반드시 확인하세요.`},
    {q:`날짜를 바꾸면 가격이 달라지나요?`, a:`네, 체크인 날짜를 1~2일 이동하면 가격이 크게 달라지는 경우가 많습니다. 꼭 비교 후 예약하세요.`},
  ]
  return `${img}
<h1>${p.keyword} 완벽 가이드 — ${p.hotelName} 후기·가격·예약 전략</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;">${p.keyword} 검색 시 가장 중요한 건 "가격 대비 실제 만족도"입니다. 이 글은 <strong>실투숙자 리뷰에서 반복되는 포인트</strong>를 기준으로 객실·조식·수영장·동선·추가요금 관점에서 선택 기준을 정리한 <strong>정보형+리뷰형 통합 가이드</strong>입니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, "👉 아고다 최저가 지금 확인하기")}
<div style="background:#f0f7ff;border-left:4px solid #1B56C5;padding:16px 20px;border-radius:8px;margin:20px 0;">
  <p style="font-weight:700;font-size:15px;margin:0 0 4px;">📍 ${p.hotelName} 핵심 정보</p>
  <p style="font-size:13px;color:#374151;margin:0;">위치: ${p.location||"예약 페이지 확인"} · 평점: ${p.score||"–"}/10 · 비교 기준: 세금/봉사료 포함 총액</p>
</div>
<h2>✅ 실투숙자 후기에서 반복되는 장점</h2>
<p>리뷰를 분석하면 <strong>위치 편의성, 청결도, 직원 친절함</strong>이 반복적으로 높은 평가를 받습니다. 특히 체크인 경험에 대한 긍정적 언급이 많으며, 야경이나 수영장 뷰에 만족한 후기가 눈에 띕니다. "기대보다 좋았다"는 표현이 자주 등장한다는 점은 가격 대비 만족도가 높다는 신호입니다.</p>
<h2>⚠️ 후기에서 나오는 아쉬운 점</h2>
<p>성수기 조식 혼잡, 특정 층 소음, 객실 컨디션 편차가 반복 언급됩니다. <strong>예약 시 층수·동(건물) 요청</strong>을 구체적으로 남기면 편차를 줄일 수 있습니다. 체크인 대기는 성수기에만 발생하므로 비수기 여행자라면 크게 걱정하지 않아도 됩니다.</p>
<h2>🛏️ 객실 선택: 같은 호텔인데 만족도가 갈리는 이유</h2>
<ul style="margin:12px 0 0 20px;line-height:2;">
  <li><strong>가족 여행</strong>: 킹/트윈 구성, 아동 추가 요금, 소파베드 유무 확인</li>
  <li><strong>커플·허니문</strong>: 오션/가든 뷰 + 발코니 + 프라이버시 우선</li>
  <li><strong>부모님 동반</strong>: 엘리베이터·조식당 동선 + 저층 소음 여부 체크</li>
</ul>
<h2>🍳 조식 & 수영장: '있다'보다 '운영 조건'이 핵심</h2>
<p>조식은 <strong>7~8시 초반</strong>에 가면 혼잡을 피할 수 있습니다. 수영장은 키즈존 분리, 타월 제공 여부, 그늘 확보가 실제 만족도를 좌우합니다. 조식 포함 여부는 <strong>총액 기준</strong>으로 비교하세요.</p>
<h2>👥 이런 여행자에게 추천 / 비추천</h2>
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
<h2>📋 예약 전 체크리스트</h2>
<ul style="margin:12px 0 0 20px;line-height:2;font-size:14px;">
  <li>☐ 무료취소 가능 여부 & 마감 시간</li><li>☐ 조식 포함 총액 비교</li>
  <li>☐ 날짜 ±2일 가격 비교</li><li>☐ 침대·층수 요청 사항 메모</li>
  <li>☐ 가족/커플/부모님 동선 확인</li>
</ul>
<h2>❓ 자주 묻는 질문 (FAQ)</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, "📅 최저가로 지금 예약하기 →")}
<h2>🏷 관련 태그</h2>
<p style="font-size:13px;color:#6b7280;">#${p.keyword.replace(/\s+/g,"")} #아고다 #호텔예약 #숙소추천 #여행팁</p>`
}

// ══════════════════════════════════════════════
// B. 리뷰형 (review) — 사람 냄새, 신뢰, 체험 중심
// ══════════════════════════════════════════════
function buildReviewHtml(p: {
  hotelName: string; affiliateUrl: string; keyword: string
  heroImageUrl?: string; score?: string; location?: string
}) {
  const img = heroImgBlock(p.heroImageUrl || FALLBACK_IMG, `${p.hotelName} 실투숙 리뷰`)
  const faqs = [
    {q:`${p.hotelName}, 실제로 묵어볼 만한가요?`, a:`리뷰 데이터 분석 결과 청결도·직원 서비스·위치 항목에서 꾸준히 높은 점수를 받고 있습니다. 기대치를 현실적으로 맞추면 만족도가 높습니다.`},
    {q:`가장 많이 언급되는 단점은 무엇인가요?`, a:`성수기 조식 대기, 일부 객실 소음, 교통비 추가 발생이 반복 언급됩니다. 예약 시 층·동 요청을 남기면 편차를 줄일 수 있습니다.`},
    {q:`커플·허니문에 적합한가요?`, a:`분위기와 프라이버시를 중시하는 커플에게 적합합니다. 오션뷰 또는 고층 객실 선택 시 만족도가 더 높습니다.`},
  ]
  return `${img}
<h1>${p.hotelName} 솔직 후기 — 실제로 묵어보면 이런 느낌입니다</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;"><strong>"사진과 얼마나 다를까?"</strong>가 가장 많이 받는 질문입니다. 이 글은 리뷰 데이터를 기반으로 <strong>실제 투숙자들이 공통적으로 느낀 것</strong>을 체감 중심으로 정리했습니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, "👉 아고다에서 현재 가격 확인")}
<h2>🚪 첫인상 — 도착하는 순간</h2>
<p>체크인 카운터까지의 동선은 짧고 안내 직원이 배치되어 있어 <strong>첫 인상 자체는 긍정적</strong>이라는 평가가 대부분입니다. 로비 공간감에 대한 언급이 많으며, "기대보다 넓고 세련됐다"는 표현이 반복됩니다. 반면 성수기에는 체크인 대기 줄이 생길 수 있으므로 <strong>오후 4~5시 이후 도착</strong>이 유리합니다.</p>
<h2>📍 위치 체감 — 실제로 이동해보면</h2>
<p>지도상 위치보다 <strong>실제 도보 체감</strong>이 중요합니다. 주요 관광지·쇼핑 거리까지의 이동 시간과 대중교통 접근성을 미리 확인하세요. 리뷰에서는 "셔틀버스 시간을 미리 파악해두면 편하다"는 팁이 자주 등장합니다.</p>
<h2>🛏️ 객실 분위기 — 사진과의 차이</h2>
<p>리뷰에서 <strong>"침구 퀄리티"와 "에어컨 소음"</strong>이 반복 언급됩니다. 전반적으로 침구 상태는 양호하다는 평가가 많지만, 에어컨 소음은 층·방향에 따라 차이가 있습니다. <strong>예약 시 "고층 + 조용한 방향" 요청</strong>을 남기면 편차를 줄일 수 있습니다.</p>
<h2>🍳 조식 체감 — 실제로 먹어보면</h2>
<p>조식 만족도는 <strong>언제 가느냐</strong>에 크게 달립니다. 성수기 8~9시는 혼잡하고 음식이 부족한 경우도 있으니 <strong>7시 초반 방문</strong>을 추천합니다. 종류는 다양하다는 평가가 일반적이며, 로컬 메뉴 구성이 특히 긍정적 언급을 받습니다.</p>
<h2>🏊 수영장 & 부대시설 — 실제 이용 후기</h2>
<p>수영장은 <strong>그늘 자리 경쟁과 타월 제공 방식</strong>이 만족도를 가릅니다. 오전 일찍 자리 확보를 추천하며, 키즈존 분리 여부는 가족 여행자에게 중요한 체크 포인트입니다.</p>
<h2>😕 아쉬운 점 — 솔직하게</h2>
<ul style="margin:12px 0 0 20px;line-height:2;">
  <li>성수기 조식·체크인 혼잡 (비수기는 해당 없음)</li>
  <li>일부 객실 에어컨 소음 (요청으로 개선 가능)</li>
  <li>공항↔호텔 이동비가 예상보다 추가될 수 있음</li>
</ul>
<h2>👥 이런 여행자에게 맞습니다</h2>
<p><strong>✅ 추천:</strong> 분위기·프라이버시 중시 커플, 부모님과 함께하는 효도 여행, 리조트 안에서 모든 것을 해결하고 싶은 여행자<br/>
<strong>❌ 비추천:</strong> 무조건 도심 접근성 1순위, 최저가만 추구, 활동적 관광 위주 일정</p>
${ctaBtn(p.affiliateUrl, BTN_BLUE, "🏨 객실·날짜별 가격 비교하기")}
<h2>❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, "📅 최저가로 예약하기 →")}
<h2>🏷 관련 태그</h2>
<p style="font-size:13px;color:#6b7280;">#${p.keyword.replace(/\s+/g,"")} #호텔후기 #아고다리뷰 #숙소후기 #여행리뷰</p>`
}

// ══════════════════════════════════════════════
// C. 비교형 (compare) — 예약 결정 유도 최강
// ══════════════════════════════════════════════
function buildCompareHtml(p: {
  hotelName: string; affiliateUrl: string; keyword: string
  heroImageUrl?: string; score?: string; location?: string
  compareHotelName?: string
}) {
  const compare = p.compareHotelName || "동급 대체 숙소"
  const img = heroImgBlock(p.heroImageUrl || FALLBACK_IMG, `${p.hotelName} vs ${compare} 비교`)
  const faqs = [
    {q:`${p.hotelName}과 ${compare} 중 어디가 더 낫나요?`, a:`목적에 따라 다릅니다. 분위기·프라이버시 중시라면 ${p.hotelName}, 가성비·위치 접근성 중시라면 ${compare}를 추천합니다.`},
    {q:`두 호텔의 가격 차이는 어느 정도인가요?`, a:`성수기/비수기에 따라 크게 달라집니다. 날짜를 바꿔가며 아고다 총액 기준으로 비교하는 것이 가장 정확합니다.`},
    {q:`가족 여행이라면 어디가 더 적합한가요?`, a:`키즈존, 객실 넓이, 조식 편의성 면에서 각 호텔의 최신 리뷰를 확인하는 것을 권장합니다.`},
  ]
  return `${img}
<h1>${p.hotelName} vs ${compare} — ${p.keyword} 어디로 예약해야 할까?</h1>
<p style="font-size:15px;color:#374151;line-height:1.8;">"둘 다 괜찮아 보이는데 어디가 더 나을까?" 이 글은 <strong>${p.hotelName}과 ${compare}를 위치·가격·객실·시설 기준으로 직접 비교</strong>해 어떤 여행자에게 무엇이 맞는지 정리했습니다.</p>
${ctaBtn(p.affiliateUrl, BTN_RED, "👉 ${p.hotelName} 지금 가격 확인")}
<h2>⚡ 한눈에 보는 비교 요약</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
  <thead><tr style="background:#1B56C5;color:#fff;">
    <th style="padding:12px;text-align:left;">항목</th>
    <th style="padding:12px;text-align:left;">${p.hotelName}</th>
    <th style="padding:12px;text-align:left;">${compare}</th>
  </tr></thead>
  <tbody>
    <tr style="background:#f8fafc;"><td style="padding:10px;border:1px solid #e2e8f0;">위치·접근성</td><td style="padding:10px;border:1px solid #e2e8f0;">아고다 확인</td><td style="padding:10px;border:1px solid #e2e8f0;">아고다 확인</td></tr>
    <tr><td style="padding:10px;border:1px solid #e2e8f0;">아고다 평점</td><td style="padding:10px;border:1px solid #e2e8f0;">${p.score||"–"}/10</td><td style="padding:10px;border:1px solid #e2e8f0;">날짜별 확인</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:10px;border:1px solid #e2e8f0;">조식 포함 여부</td><td style="padding:10px;border:1px solid #e2e8f0;">옵션 선택</td><td style="padding:10px;border:1px solid #e2e8f0;">옵션 선택</td></tr>
    <tr><td style="padding:10px;border:1px solid #e2e8f0;">수영장</td><td style="padding:10px;border:1px solid #e2e8f0;">리뷰 확인</td><td style="padding:10px;border:1px solid #e2e8f0;">리뷰 확인</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:10px;border:1px solid #e2e8f0;">가격대</td><td style="padding:10px;border:1px solid #e2e8f0;">날짜별 상이</td><td style="padding:10px;border:1px solid #e2e8f0;">날짜별 상이</td></tr>
  </tbody>
</table>
<h2>📍 위치 비교 — 실제 이동 체감</h2>
<p>${p.hotelName}은 <strong>${p.location||"위치 확인 필요"}</strong>에 위치합니다. ${compare}와의 핵심 차이는 주요 관광지 도보 접근성과 대중교통 노선입니다. 공항 이동 시간도 체크인 날짜 동선에 따라 선택이 달라질 수 있습니다.</p>
<h2>💰 가격 비교 전략</h2>
<p>두 호텔 모두 <strong>성수기와 비수기 가격 차이가 큽니다.</strong> 총액(세금·봉사료 포함) 기준으로 비교하고, 날짜를 ±2일 이동하면서 확인하는 것이 핵심입니다.</p>
${ctaBtn(p.affiliateUrl, BTN_BLUE, `🏨 ${p.hotelName} 날짜별 가격 비교`)}
<h2>🛏️ 객실 비교</h2>
<p>${p.hotelName}은 <strong>뷰와 프라이버시</strong>에서 높은 평가를 받고, ${compare}는 <strong>가성비와 위치</strong>면에서 경쟁력이 있습니다. 가족 여행자라면 키즈 동반 정책과 소파베드 유무를 각각 확인하세요.</p>
<h2>👥 여행자 유형별 최종 선택 가이드</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0;">
  <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:14px;">
    <strong style="color:#1B56C5;">${p.hotelName} 선택 시</strong>
    <ul style="margin:8px 0 0 16px;font-size:14px;line-height:1.9;"><li>허니문·커플 분위기 중시</li><li>리조트 올인 클루시브 선호</li><li>평점·서비스 우선</li></ul>
  </div>
  <div style="background:#faf5ff;border:1px solid #d8b4fe;border-radius:10px;padding:14px;">
    <strong style="color:#7c3aed;">${compare} 선택 시</strong>
    <ul style="margin:8px 0 0 16px;font-size:14px;line-height:1.9;"><li>도심 접근성 최우선</li><li>예산 절약 후 액티비티 투자</li><li>이동 많은 관광형 일정</li></ul>
  </div>
</div>
<h2>❓ 자주 묻는 질문</h2>
${faqs.map(f=>`<details style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><summary style="padding:14px 16px;font-weight:600;cursor:pointer;background:#f8fafc;">Q. ${f.q}</summary><div style="padding:14px 16px;font-size:14px;line-height:1.7;">A. ${f.a}</div></details>`).join("")}
${faqSchema(faqs)}
${ctaBtn(p.affiliateUrl, BTN_GREEN, `📅 ${p.hotelName} 최저가로 예약하기 →`)}
<h2>🏷 관련 태그</h2>
<p style="font-size:13px;color:#6b7280;">#${p.keyword.replace(/\s+/g,"")} #호텔비교 #아고다 #숙소선택 #여행팁</p>`
}

// ══════════════════════════════════════════════
// 제목 패턴 다양화 (6개 패턴 순환)
// ══════════════════════════════════════════════
function buildTitle(hotelName: string, keyword: string, formatType: FormatType, titlePattern?: number): string {
  const year = new Date().getFullYear()
  const patterns: Record<FormatType, string[]> = {
    hybrid: [
      `${year} ${hotelName} 리뷰 | 위치·객실·조식·가격 총정리`,
      `${keyword} 완벽 가이드 — ${hotelName} 후기 기반 핵심 정리`,
      `${hotelName} 숙박 체크포인트 | 예약 전 꼭 읽어야 할 분석`,
      `${year} ${keyword} — ${hotelName} 장단점·예약 전략 총정리`,
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
      `${hotelName} vs 대체 숙소 — ${keyword} 어디로 예약해야 할까?`,
      `${year} ${keyword} 비교 | ${hotelName} 선택 기준 완전 분석`,
      `${hotelName} 직접 비교 — 가격·위치·객실 3가지 기준으로`,
      `${keyword} 선택 가이드 | ${hotelName}이 정답인 여행자 유형`,
      `${hotelName} vs 경쟁 호텔 — 어떤 여행자에게 더 나을까?`,
      `${year} ${keyword} | ${hotelName} 예약 전 반드시 비교해야 할 것들`,
    ],
  }
  const list = patterns[formatType] || patterns.hybrid
  const idx  = typeof titlePattern === "number" ? titlePattern % list.length : Math.floor(Math.random() * list.length)
  return list[idx]
}

// ══════════════════════════════════════════════
// 메인 핸들러
// ══════════════════════════════════════════════
export async function POST(req: NextRequest) {
  try {
    const headerKey  = safeStr(req.headers.get("x-api-key"))
    const internalKey = getInternalApiKey()
    if (!internalKey || headerKey !== internalKey) return unauthorized()

    let body: any = {}
    try { body = await req.json() } catch { return badRequest("Invalid JSON body") }

    const keyword         = safeStr(body.keyword);   if (!keyword)  return badRequest("keyword required")
    const hotelId         = safeStr(body.hotelId);   if (!hotelId)  return badRequest("hotelId required")
    const formatType      = (safeStr(body.formatType) || "hybrid") as FormatType
    const publishType     = (safeStr(body.publishType) || "draft") as PublishType
    const category        = typeof body.category === "number" ? body.category : undefined
    const compareHotelName = safeStr(body.compareHotelName)
    const titlePattern    = typeof body.titlePattern === "number" ? body.titlePattern : undefined
    const customSlug      = safeStr(body.slug)
    const customSeoTitle  = safeStr(body.seoTitle)
    const customSeoDesc   = safeStr(body.seoDescription)
    const focusKeyword    = safeStr(body.focusKeyword) || keyword

    if (!["hybrid","review","compare"].includes(formatType)) return badRequest("formatType: hybrid|review|compare")

    // Agoda 호텔 정보 조회
    const agodaData  = await agodaGetHotelById(hotelId)
    const first      = (agodaData?.results && Array.isArray(agodaData.results) && agodaData.results[0]) || agodaData
    const hotelName  = safeStr(first?.hotelName) || safeStr(first?.propertyName) || keyword
    const score      = typeof first?.reviewScore === "number" ? first.reviewScore.toFixed(1) : undefined
    const cityName   = safeStr(first?.cityName)
    const countryName = safeStr(first?.countryName)
    const location   = [cityName, countryName].filter(Boolean).join(", ") || undefined
    const heroImgUrl = safeStr(first?.imageURL) ||
      `https://pix6.agoda.net/hotelImages/${hotelId.slice(0,3)}/${hotelId}/${hotelId}_main.jpg?s=1024x768`

    // WordPress 이미지 업로드
    const featuredMediaId = await wpUploadImage(heroImgUrl, hotelId)

    // 아고다 제휴 URL
    const cid          = safeStr(process.env.AGODA_AFFILIATE_CID) || "1959499"
    const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(hotelId)}&cid=${encodeURIComponent(cid)}&hl=ko-kr&rooms=1&adults=2`

    // 제목 생성 (다양화 패턴)
    const title = buildTitle(hotelName, keyword, formatType, titlePattern)
    const seoTitle = customSeoTitle || title
    const seoDescription = customSeoDesc ||
      `${title.slice(0,30)}... 실투숙자 리뷰 분석, 객실 디테일, 가격 전략, 아고다 최저가 예약 방법까지 총정리.`

    // 포맷별 HTML 생성
    const params = { hotelName, affiliateUrl, keyword, heroImageUrl: heroImgUrl, score, location, compareHotelName }
    let html: string
    switch (formatType) {
      case "review":  html = buildReviewHtml(params);  break
      case "compare": html = buildCompareHtml(params); break
      default:        html = buildHybridHtml(params);  break
    }
    // Hotel Schema 추가
    html += hotelSchema(hotelName, location||"", score||"", "")

    // 유효성 검사
    const warnings = validateOutput(html, title, seoTitle, seoDescription)

    // WordPress 발행
    const slug = customSlug || keyword.toLowerCase().replace(/[^\w\s-]/g,"").replace(/\s+/g,"-").slice(0,60)
    const wp   = await wpCreatePost({ title, content: html, status: publishType, category, featuredMediaId, slug, seoTitle, seoDescription, focusKeyword })

    return json({
      success: true,
      format: formatType,
      resolved: { keyword, hotelId, hotelName, title, affiliateUrl, heroImgUrl },
      warnings: warnings.length > 0 ? warnings : undefined,
      wp,
    })
  } catch(e: any) {
    console.error("API ERROR:", e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
