import { NextResponse } from "next/server"

/**
 * ENV
 * - API_KEY: Vercel API 보호용 (요청 헤더 x-api-key)
 * - WP_URL, WP_USERNAME, WP_APP_PASSWORD: WP 발행용
 * - AGODA_AUTH: "siteId:apiKey" 형태 (partners API용)
 * - AGODA_CID: (선택) 제휴 cid 고정 (없으면 기본값 사용)
 */

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3"

// -------------------------
// Utils
// -------------------------
function jsonError(status: number, message: string, extra?: any) {
  return NextResponse.json({ success: false, message, ...extra }, { status })
}

function pick<T>(arr: T[], seed: number) {
  if (!arr.length) throw new Error("empty array")
  const idx = Math.abs(seed) % arr.length
  return arr[idx]
}

function hashSeed(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function normalizePublishType(v: any): PublishType {
  const s = String(v || "").toLowerCase().trim()
  if (s === "publish") return "publish"
  if (s === "future") return "future"
  return "draft" // ✅ 기본 draft
}

function normalizeVersion(v: any): Version {
  const s = String(v || "").toUpperCase().trim()
  if (s === "V1") return "V1"
  if (s === "V2") return "V2"
  return "V3" // ✅ 기본 V3 (긴 글)
}

function toYMD(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function getDefaultDates() {
  // 오늘 +30일 / +33일 (대충 한 달 뒤 3박)
  const now = new Date()
  const inDate = new Date(now)
  const outDate = new Date(now)
  inDate.setDate(inDate.getDate() + 30)
  outDate.setDate(outDate.getDate() + 33)
  return { checkInDate: toYMD(inDate), checkOutDate: toYMD(outDate) }
}

function base64(s: string) {
  return Buffer.from(s).toString("base64")
}

// hotelUrl 에서 hid 추출 (partnersearch hid=xxxx 형태)
function extractHidFromHotelUrl(hotelUrl: string) {
  try {
    const u = new URL(hotelUrl)
    const hid = u.searchParams.get("hid")
    return hid ? String(hid).trim() : ""
  } catch {
    return ""
  }
}

// pix8 이미지 URL size 파라미터 바꾸기
function ensureSize(url: string, size: string) {
  // ...?ce=0&s=800x600 형태를 s=1200x800 등으로 교체
  try {
    const u = new URL(url)
    if (u.searchParams.has("s")) u.searchParams.set("s", size)
    else u.searchParams.set("s", size)
    return u.toString()
  } catch {
    // URL 파싱 실패 시 대충 처리
    if (url.includes("s=")) return url.replace(/s=\d+x\d+/g, `s=${size}`)
    return url + (url.includes("?") ? "&" : "?") + `s=${size}`
  }
}

function buildImageUrls(imageURL?: string, imageUrls?: string[]) {
  const out: string[] = []

  const pushUnique = (u?: string) => {
    if (!u) return
    const x = String(u).trim()
    if (!x) return
    if (!out.includes(x)) out.push(x)
  }

  // 1) 배열이 있으면 우선
  if (Array.isArray(imageUrls)) imageUrls.forEach(pushUnique)

  // 2) 단일이 있으면 추가 + 사이즈 파생
  if (imageURL) {
    pushUnique(ensureSize(imageURL, "1200x800"))
    pushUnique(ensureSize(imageURL, "1000x750"))
    pushUnique(ensureSize(imageURL, "800x600"))
  }

  // 3) 최소 3장 확보(부족하면 마지막을 반복)
  if (out.length === 1) {
    out.push(out[0], out[0])
  } else if (out.length === 2) {
    out.push(out[1])
  } else if (out.length > 3) {
    return out.slice(0, 3)
  }
  return out
}

// -------------------------
// Agoda Partners fetch
// -------------------------
async function agodaFetchHotelByHid(hid: string) {
  const AGODA_AUTH = process.env.AGODA_AUTH
  if (!AGODA_AUTH) throw new Error("Missing env: AGODA_AUTH")

  // partners hotel search endpoint (예전 코드 흐름 유지)
  // 실제 동작은 네 프로젝트에서 이미 성공 중이므로, 구조만 안정적으로 유지
  const endpoint = "https://www.agoda.com/partners/partnersearch.aspx"

  // partnersearch.aspx 자체를 호출해서 HTML 파싱하는 방식이면 위험하니,
  // 네 코드가 이미 쓰는 "internal fetch" 방식이 있다면 여길 그 로직으로 바꾸면 됨.
  // 여기서는 "이미 네 서비스가 hid로 hotelName/imageURL/reviewScore 를 얻는다"는 전제하에,
  // route.ts에서는 해당 값을 '필수'로 만들어서 실패 시 명확히 안내함.

  // ✅ 현재는 hid만으로는 이 함수가 직접 데이터를 못 가져오는 구조일 수 있으니,
  // 네 기존 구현(배포된 코드)의 agoda fetch 로직을 그대로 쓰는 게 정답.
  // 따라서: 이 함수는 "실제 데이터는 route 내 기존 로직으로 채워진다" 형태로 사용하지 않도록 하고,
  // 아래 route에서 hotelUrl(파트너 링크) 기반으로 affiliateUrl만 만들고,
  // hotelName/imageURL/reviewScore는 body에서 넘어오거나(테스트/수동), 또는 기존 네 fetch 함수로 채워.
  return { endpoint, hid }
}

// -------------------------
// Title Builder (SEO 랜덤화)
// -------------------------
function buildTitle(keyword: string, hotelName: string, version: Version) {
  const seed = hashSeed(keyword + "|" + hotelName + "|" + version)
  const v3 = [
    `${hotelName} | ${keyword} 예약 전 꼭 볼 정보`,
    `${keyword} 추천: ${hotelName} 후기·시설·예약팁 총정리`,
    `${hotelName} 완벽 가이드 | ${keyword} 최저가 체크 포인트`,
    `${keyword} 숙소로 ${hotelName} 어때? 핵심만 정리`,
  ]
  const v2 = [
    `${keyword} 인기 숙소: ${hotelName} 한눈에 보기`,
    `${hotelName} | ${keyword} 가성비·위치·시설 요약`,
    `${keyword} 숙소 추천: ${hotelName} 체크리스트`,
    `${hotelName} 예약 가이드 | ${keyword} 핵심 요약`,
  ]
  const v1 = [`${hotelName} | ${keyword} 예약 가이드`]

  if (version === "V1") return v1[0]
  if (version === "V2") return pick(v2, seed)
  return pick(v3, seed)
}

// -------------------------
// HTML Builder (A안 = V3 긴 글 기본)
// -------------------------
function buildHtml(params: {
  version: Version
  keyword: string
  hotelName: string
  reviewScore?: number
  affiliateUrl: string
  cityName?: string
  countryName?: string
  checkInDate?: string
  checkOutDate?: string
  imageURL?: string
  imageUrls?: string[]
}) {
  const {
    version,
    keyword,
    hotelName,
    reviewScore,
    affiliateUrl,
    cityName,
    countryName,
    checkInDate,
    checkOutDate,
    imageURL,
    imageUrls,
  } = params

  const seed = hashSeed(keyword + "|" + hotelName)
  const imgs = buildImageUrls(imageURL, imageUrls)

  const scoreText =
    typeof reviewScore === "number"
      ? `${reviewScore.toFixed(1)} / 10`
      : "예약 페이지에서 확인"

  const locationText =
    [countryName, cityName].filter(Boolean).join(" ") || "예약 페이지에서 확인"

  const tagsPool = [
    ["#가족여행", "#리조트휴양", "#수영장좋은숙소"],
    ["#커플여행", "#허니문", "#오션뷰"],
    ["#가성비숙소", "#첫방문", "#동선좋은숙소"],
    ["#키즈프렌들리", "#부대시설", "#조식맛집"],
  ]
  const tags = pick(tagsPool, seed).join(" ")

  const introPool = [
    `여행 준비할 때 숙소에서 시간을 가장 많이 쓰죠. 특히 <strong>${keyword}</strong>처럼 검색량이 많은 키워드는 정보가 넘쳐서 오히려 결정이 어려워요. 그래서 이 글은 “예약 직전” 단계에서 필요한 핵심만 정리했습니다.`,
    `숙소는 사진만 보고 고르면 실패 확률이 올라가요. <strong>${keyword}</strong>로 찾는 분들이 자주 놓치는 포인트(동선/조식/객실 타입/성수기 요금)를 중심으로 <strong>${hotelName}</strong>을 정리했어요.`,
    `리조트형 숙소는 “어디에 있느냐”가 체감 만족도를 크게 좌우해요. <strong>${keyword}</strong>로 <strong>${hotelName}</strong>을 고민 중이라면, 아래 체크리스트만 봐도 선택이 훨씬 쉬워질 거예요.`,
  ]
  const intro = pick(introPool, seed)

  // ✅ V3 = 2,000자+ 확실히 만들기 위한 본문 블록 (고정 + 변주)
  const whyPool = [
    `이 키워드가 많이 검색되는 이유는 대개 3가지예요. (1) 일정 대부분을 숙소에서 해결하는 “올인원 동선”, (2) 가족/커플 모두 무난한 객실 구성, (3) 성수기에도 선택지가 많아 비교가 쉬운 점. 특히 리조트는 ‘부대시설’이 일정의 절반을 결정하니, 수영장/키즈존/해변 접근성을 꼭 확인하세요.`,
    `검색량이 높은 숙소는 장점이 분명하지만, 단점도 같이 따라옵니다. 대표적으로 성수기 혼잡도, 객실동 위치에 따른 소음/전망 차이, 조식 시간대 대기 같은 요소들이죠. 그래서 예약 전에 “방 타입/전망/무료취소 마감일”만 확인해도 만족도가 크게 올라가요.`,
    `후기를 보면 칭찬 포인트가 반복됩니다. 수영장 규모, 조식 구성, 직원 응대, 그리고 객실 컨디션. 반대로 아쉬운 점도 반복돼요. 외부 이동 거리, 체크인 대기, 성수기 가격 급등 같은 것들. 이 글에서는 그 반복 포인트를 기준으로 판단할 수 있게 정리했어요.`,
  ]
  const why = pick(whyPool, seed)

  const roomPool = [
    `객실은 “기본형 → 업그레이드형(전망/면적) → 특수형(스위트/빌라)” 순으로 고민하면 쉬워요. 보통 만족도를 가르는 건 침대 타입보다 <strong>전망</strong>과 <strong>객실동 위치</strong>입니다. 리조트형 숙소는 로비/조식당/수영장까지 이동 동선이 길 수 있어서, 이동이 부담이라면 ‘메인 시설과 가까운 동’이 체감이 좋아요.`,
    `가족 여행이라면 커넥팅룸/엑스트라베드 정책이 핵심이에요. 숙소마다 추가 인원 요금이나 조식 포함 범위가 달라서, “어른 2 + 아이” 구성이라면 예약 옵션을 꼭 비교하세요. 커플/허니문이라면 오션뷰/하이층/발코니 여부가 만족도를 끌어올리는 포인트가 됩니다.`,
    `객실 컨디션은 ‘최근 리노베이션 여부’가 중요하지만, 예약 페이지에서 확인이 어려울 때가 많아요. 이럴 때는 후기에서 “샤워 수압/침구/냄새/에어컨” 언급이 많은지 보세요. 같은 호텔이어도 객실동에 따라 편차가 생깁니다.`,
  ]
  const room = pick(roomPool, seed)

  const facilityPool = [
    `수영장/해변은 사진만 보면 다 좋아 보이지만, 실제로는 <strong>그늘(선베드 수)</strong>과 <strong>바람</strong>, 그리고 <strong>아이 동반 안전성</strong>에서 차이가 나요. 메인풀은 사람이 몰릴 수 있으니 오전/해질녘 이용이 만족도가 높고, 키즈풀/슬라이드 운영시간은 시즌마다 바뀌니 예약 페이지나 공지 확인을 추천해요.`,
    `조식은 “구성(메뉴 다양성)”과 “혼잡(대기/좌석)”이 포인트입니다. 성수기에는 8~9시가 피크라 대기가 생길 수 있어요. 일정이 빡빡하면 오픈런(첫 타임)으로 시간을 절약하는 게 좋고, 커피/즉석 코너(쌀국수/오믈렛)가 잘 운영되는지 후기를 체크해보세요.`,
    `부대시설은 ‘있다/없다’보다 ‘운영시간/예약제/유료 여부’가 중요합니다. 스파·키즈클럽·셔틀은 유료 또는 시간대 제한이 있는 경우가 많고, 인기 프로그램은 미리 예약이 필요할 수 있어요.`,
  ]
  const facility = pick(facilityPool, seed)

  const checklist = [
    `무료취소 마감일(언제까지 수수료 0원인지)`,
    `조식 포함/불포함 가격 차이(총액 기준으로 비교)`,
    `객실 타입(전망/침대/인원 정책)과 추가요금`,
    `성수기 가격 변동(1~2일만 바꿔도 차이 나는지)`,
    `공항/역 이동 시간 + 셔틀/택시 비용 대략`,
  ]

  const faq = [
    {
      q: `${hotelName} 체크인/체크아웃 팁이 있나요?`,
      a: `정확한 시간은 예약 페이지 정책이 기준이에요. 늦은 체크인이라면 프런트 운영/야간 체크인 가능 여부를 확인해두면 좋아요.`,
    },
    {
      q: `${hotelName} 조식은 어떤가요?`,
      a: `조식은 시즌/요일에 따라 구성이 달라질 수 있어요. 혼잡 시간대(보통 8~9시)를 피하면 체감 만족도가 올라갑니다.`,
    },
    {
      q: `${hotelName} 가족 여행에 괜찮나요?`,
      a: `가족이라면 객실 인원 정책, 키즈풀/키즈존 유무, 이동 동선(로비↔객실↔수영장)을 먼저 체크하는 걸 추천해요.`,
    },
  ]

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((x) => ({
      "@type": "Question",
      name: x.q,
      acceptedAnswer: { "@type": "Answer", text: x.a },
    })),
  }

  // ✅ V1/V2는 필요하면 축약 가능하지만, A안은 기본 V3로 길게 고정
  const isLong = version === "V3"

  const hero = `
<div style="text-align:center;margin:18px 0;">
  <img src="${imgs[0]}" alt="${hotelName} 대표 이미지" style="max-width:100%;border-radius:14px;" />
</div>`

  const cta1 = `
<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>`

  const infoBox = `
<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
  <div style="font-weight:900;font-size:16px;margin-bottom:10px;">🏨 호텔 기본 정보</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.55;">
    <div><b>호텔명</b><br/>${hotelName}</div>
    <div><b>키워드</b><br/>${keyword}</div>
    <div><b>위치</b><br/>${locationText}</div>
    <div><b>평점</b><br/>${scoreText}</div>
    <div><b>추천 일정</b><br/>${checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 확인"}</div>
    <div><b>추천 태그</b><br/>${tags}</div>
  </div>
  <div style="margin-top:10px;color:#374151;font-size:13px;">
    조건(날짜/요금/방 타입)에 따라 체감 만족도가 크게 달라질 수 있어요.
  </div>
</div>`

  const gallery = `
<h2>객실/전경 이미지</h2>
<div style="display:grid;grid-template-columns:1fr;gap:12px;margin:14px 0;">
  <img src="${imgs[1]}" alt="${hotelName} 객실 이미지" style="max-width:100%;border-radius:14px;" />
  <img src="${imgs[2]}" alt="${hotelName} 전경/부대시설 이미지" style="max-width:100%;border-radius:14px;" />
</div>`

  const cta2 = `
<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
    👉 현재 날짜로 가격/객실 확인
  </a>
</div>`

  const checklistHtml = `
<h2>예약 전 체크리스트</h2>
<ul style="margin:10px 0 0 18px;">
  ${checklist.map((x) => `<li style="margin:7px 0;">${x}</li>`).join("")}
</ul>`

  const cta3 = `
<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
    👉 예약 페이지로 이동
  </a>
</div>`

  const faqHtml = `
<h2>자주 묻는 질문(FAQ)</h2>
<div style="margin-top:10px;">
  ${faq
    .map(
      (x) => `
    <div style="margin:12px 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
      <div style="font-weight:900;">Q. ${x.q}</div>
      <div style="margin-top:8px;color:#374151;line-height:1.7;">A. ${x.a}</div>
    </div>`
    )
    .join("")}
</div>`

  const hashtags = `
<h2>해시태그</h2>
<p>${[...new Set([keyword, "숙소추천", "리조트", "가족여행", "커플여행"].map((x) => `#${String(x).replace(/\s+/g, "")}`))].join(" ")}</p>`

  const schemaScript = `
<script type="application/ld+json">
${JSON.stringify(faqJsonLd, null, 2)}
</script>`

  const longBody = `
<h1>${keyword} 추천 호텔: ${hotelName}</h1>
<p>${intro}</p>

${cta1}
${hero}
${infoBox}

<h2>왜 ${keyword} 검색이 많을까?</h2>
<p>${why}</p>

<h2>객실 구성과 실제 체감</h2>
<p>${room}</p>

<h2>수영장·조식·부대시설 포인트</h2>
<p>${facility}</p>

${gallery}

<h2>이런 여행자에게 추천</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">아이 동반 가족 여행(키즈 동선/시설 중시)</li>
  <li style="margin:7px 0;">리조트 중심 휴양 일정(숙소 내에서 대부분 해결)</li>
  <li style="margin:7px 0;">커플/허니문(전망·분위기·프라이버시 중시)</li>
  <li style="margin:7px 0;">부대시설(수영장/스파/키즈존) 활용도가 높은 여행</li>
</ul>

${checklistHtml}
${cta2}
${faqHtml}
${cta3}
${hashtags}
${schemaScript}
`.trim()

  const shortBody = `
${hero}
<h2>${keyword} 추천 호텔: ${hotelName}</h2>
<p>시간 아끼려고 핵심만 담았어요. 예약 전에 아래 체크리스트만 확인해도 충분해요.</p>
${cta1}
${infoBox}
${checklistHtml}
${cta2}
${faqHtml}
${hashtags}
${schemaScript}
`.trim()

  // ✅ A안은 기본 V3이므로 longBody가 기본
  return isLong ? longBody : shortBody
}

// -------------------------
// WP Create Post (Rank Math + slug + excerpt)
// -------------------------
async function wpCreatePost(params: {
  title: string
  content: string
  status: PublishType
  category: number
  publishAt?: string

  slug?: string
  seoTitle?: string
  seoDescription?: string
  focusKeyword?: string
  canonicalUrl?: string
}) {
  const WP_URL = process.env.WP_URL
  const WP_USERNAME = process.env.WP_USERNAME
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD

  if (!WP_URL) throw new Error("Missing env: WP_URL")
  if (!WP_USERNAME) throw new Error("Missing env: WP_USERNAME")
  if (!WP_APP_PASSWORD) throw new Error("Missing env: WP_APP_PASSWORD")

  // ✅ draft 기본, publish/future만 그대로 허용
  const finalStatus: PublishType =
    params.status === "publish" || params.status === "future" ? params.status : "draft"

  const auth = base64(`${WP_USERNAME}:${WP_APP_PASSWORD}`)

  const body: any = {
    title: params.title,
    content: params.content,
    status: finalStatus,
    categories: [Number(params.category)],
  }

  // ✅ slug
  if (params.slug) body.slug = params.slug

  // ✅ excerpt를 seoDescription으로(없으면 생략)
  if (params.seoDescription) body.excerpt = params.seoDescription

  // ✅ Rank Math meta (WPCode에서 show_in_rest 열어둔 상태여야 저장됨)
  body.meta = {
    ...(params.seoTitle ? { rank_math_title: params.seoTitle } : {}),
    ...(params.seoDescription ? { rank_math_description: params.seoDescription } : {}),
    ...(params.focusKeyword ? { rank_math_focus_keyword: params.focusKeyword } : {}),
    ...(params.canonicalUrl ? { rank_math_canonical_url: params.canonicalUrl } : {}),
  }

  // 예약발행
  if (finalStatus === "future") {
    let publishAt = params.publishAt
    if (!publishAt) {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      publishAt = d.toISOString()
    }
    body.date = publishAt
  }

  const endpoint = `${WP_URL.replace(/\/$/, "")}/wp-json/wp/v2/posts`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {}

  if (!res.ok) throw new Error(`WP API failed: ${res.status} ${text}`)
  return data
}

// -------------------------
// Main Endpoint
// POST /api/wp/post
// -------------------------
export async function POST(req: Request) {
  try {
    // ✅ API KEY 체크
    const API_KEY = process.env.API_KEY
    if (API_KEY) {
      const incoming = req.headers.get("x-api-key") || ""
      if (incoming !== API_KEY) return jsonError(401, "Unauthorized: invalid x-api-key")
    }

    const body = await req.json().catch(() => ({} as any))

    const keyword = String(body.keyword || "").trim()
    if (!keyword) return jsonError(400, "keyword is required")

    const inputHotelId = body.hotelId ? String(body.hotelId).trim() : ""
    const hotelUrl = body.hotelUrl ? String(body.hotelUrl).trim() : ""

    // ✅ 기본 V3 / 기본 draft
    const version = normalizeVersion(body.version)
    const publishType = normalizePublishType(body.publishType)
    const category = Number(body.category ?? 1)

    const { checkInDate: defIn, checkOutDate: defOut } = getDefaultDates()
    const checkInDate = body.checkInDate ? String(body.checkInDate).trim() : defIn
    const checkOutDate = body.checkOutDate ? String(body.checkOutDate).trim() : defOut

    const slug = body.slug ? String(body.slug).trim() : undefined
    const seoTitle = body.seoTitle ? String(body.seoTitle).trim() : undefined
    const seoDescription = body.seoDescription ? String(body.seoDescription).trim() : undefined
    const focusKeyword = body.focusKeyword ? String(body.focusKeyword).trim() : undefined
    const canonicalUrl = body.canonicalUrl ? String(body.canonicalUrl).trim() : undefined

    const hl = body.hl ? String(body.hl).trim() : "ko-kr"
    const adults = body.adults ? Number(body.adults) : 2
    const rooms = body.rooms ? Number(body.rooms) : 1

    // ✅ hotelId 결정 (hid)
    let hotelId = inputHotelId
    if (!hotelId && hotelUrl) {
      hotelId = extractHidFromHotelUrl(hotelUrl)
    }

    // 🔥 키워드만으로 자동 매칭은 실패가 잦아서, A안에서는 hid or hotelUrl 권장
    if (!hotelId) {
      return jsonError(400, "hotelId(hid) 또는 hotelUrl(파트너 링크, hid 포함)이 필요합니다.", {
        hint: {
          example: {
            keyword,
            hotelId: "625168",
            publishType: "draft",
            version: "V3",
          },
        },
      })
    }

    // ✅ affiliateUrl 생성 (partnersearch hid 기반)
    const AGODA_CID = process.env.AGODA_CID || "1959499"
    const affiliateUrl =
      `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(hotelId)}` +
      `&cid=${encodeURIComponent(AGODA_CID)}` +
      `&hl=${encodeURIComponent(hl)}` +
      `&rooms=${encodeURIComponent(String(rooms))}` +
      `&adults=${encodeURIComponent(String(adults))}` +
      (checkInDate ? `&checkIn=${encodeURIComponent(checkInDate)}` : "") +
      (checkOutDate ? `&checkOut=${encodeURIComponent(checkOutDate)}` : "")

    // ✅ (선택) body에서 호텔 상세를 넘길 수도 있게(테스트/수동)
    const hotelName = body.hotelName ? String(body.hotelName).trim() : ""
    const reviewScore = body.reviewScore !== undefined ? Number(body.reviewScore) : undefined
    const imageURL = body.imageURL ? String(body.imageURL).trim() : undefined
    const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : undefined
    const cityName = body.cityName ? String(body.cityName).trim() : undefined
    const countryName = body.countryName ? String(body.countryName).trim() : undefined

    // ✅ hotelName 없으면 최소 안전 문구
    const safeHotelName = hotelName || `Agoda Hotel (hid:${hotelId})`

    // ✅ 제목 랜덤화(SEO)
    const title = buildTitle(keyword, safeHotelName, version)

    // ✅ 본문(기본 V3 긴 글)
    const content = buildHtml({
      version,
      keyword,
      hotelName: safeHotelName,
      reviewScore,
      affiliateUrl,
      cityName,
      countryName,
      checkInDate,
      checkOutDate,
      imageURL,
      imageUrls,
    })

    // ✅ WP 발행(기본 draft)
    const wp = await wpCreatePost({
      title,
      content,
      status: publishType,
      category,
      slug,
      seoTitle,
      seoDescription,
      focusKeyword,
      canonicalUrl,
    })

    return NextResponse.json({
      success: true,
      resolved: {
        keyword,
        hotelId,
        affiliateUrl,
        version,
        publishType,
        slug,
        seoTitle,
        seoDescription,
        focusKeyword,
        canonicalUrl,
        imageURL,
        imageUrls,
      },
      wp,
    })
  } catch (err: any) {
    return jsonError(500, err?.message || "Unknown error", { stack: String(err?.stack || "") })
  }
}