import { NextResponse } from "next/server"

export const runtime = "nodejs"

/**
 * ✅ 필수 ENV
 * - API_KEY: 네 Vercel API 보호용(x-api-key)
 * - WP_URL, WP_USERNAME, WP_APP_PASSWORD: WP 발행용
 * - AGODA_AUTH: "siteId:apiKey" 형태 (예: "1959499:8c98....")
 *
 * (선택) - AGODA_CID: 있으면 affiliate 링크에 기본 cid로 사용 (없으면 siteId 사용)
 */

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3" | "V4"

function jsonError(status: number, message: string, detail?: any) {
  return NextResponse.json({ error: message, detail }, { status })
}

function base64(s: string) {
  return Buffer.from(s, "utf8").toString("base64")
}

function safeStr(v: any) {
  return typeof v === "string" ? v.trim() : ""
}

function normalizePublishType(v: any): PublishType {
  if (v === "publish" || v === "future" || v === "draft") return v
  return "draft"
}

function normalizeVersion(v: any): Version {
  if (v === "V1" || v === "V2" || v === "V3" || v === "V4") return v
  return "V1"
}

function getDefaultDates() {
  // 오늘 + 30일 / +31일 (가용 객실 확률 ↑)
  const now = new Date()
  const inDate = new Date(now)
  inDate.setDate(inDate.getDate() + 30)
  const outDate = new Date(now)
  outDate.setDate(outDate.getDate() + 31)

  const toYMD = (d: Date) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }

  return { checkInDate: toYMD(inDate), checkOutDate: toYMD(outDate) }
}

/**
 * ✅ Agoda 인증: AGODA_AUTH = "siteId:apiKey"
 */
function getAgodaAuthFromEnv() {
  const AGODA_AUTH = process.env.AGODA_AUTH
  if (!AGODA_AUTH) throw new Error("Missing env: AGODA_AUTH (format: siteId:apiKey)")

  const parts = AGODA_AUTH.split(":")
  if (parts.length < 2) throw new Error("Invalid AGODA_AUTH format. Must be siteId:apiKey")

  const siteId = parts[0].trim()
  const apiKey = parts.slice(1).join(":").trim()
  if (!siteId || !apiKey) throw new Error("Invalid AGODA_AUTH value (empty siteId or apiKey)")

  return { siteId, apiKey, authHeader: `${siteId}:${apiKey}` }
}

/**
 * ✅ hotelUrl(예: partnersearch)에서 hid 추출
 */
function extractHotelIdFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const hid = u.searchParams.get("hid")
    if (hid && /^\d+$/.test(hid)) return hid
  } catch {
    // URL 파싱 실패 시 regex로 한번 더
  }
  const m = url.match(/[\?&]hid=(\d{3,12})/i)
  return m?.[1] ?? null
}

/**
 * ✅ (옵션) keyword로 Agoda 웹 검색 페이지를 긁어서 hid(=hotelId) 하나 뽑기
 * - 안정성은 hotelUrl/hid 직접 입력이 더 좋음
 */
async function resolveHotelIdFromKeyword(keyword: string, cid: string, hl = "ko-kr") {
  const { checkInDate, checkOutDate } = getDefaultDates()
  const candidates = [
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&textToSearch=${encodeURIComponent(
      keyword
    )}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&city=${encodeURIComponent(
      keyword
    )}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&asq=${encodeURIComponent(
      keyword
    )}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
  ]

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  }

  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "GET", headers })
      if (!res.ok) continue
      const html = await res.text()

      const hidMatch =
        html.match(/[\?&]hid=(\d{3,12})/i) ||
        html.match(/"hotelId"\s*:\s*(\d{3,12})/i) ||
        html.match(/hotelId%22%3A(\d{3,12})/i)

      if (hidMatch?.[1]) return hidMatch[1]
    } catch {
      // 다음 후보
    }
  }
  return null
}

/**
 * ✅ Agoda lt_v1: hotelId 기반 조회
 */
async function agodaGetHotelById(hotelId: string, checkInDate?: string, checkOutDate?: string) {
  const AGODA_URL = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"
  const { authHeader } = getAgodaAuthFromEnv()

  const defaults = getDefaultDates()
  const inDate = checkInDate || defaults.checkInDate
  const outDate = checkOutDate || defaults.checkOutDate

  const payload = {
    criteria: {
      language: "ko-kr",
      currency: "KRW",
      occupancy: { numberOfAdult: 2, numberOfChildren: 0 },
      checkInDate: inDate,
      checkOutDate: outDate,
      hotelId: [Number(hotelId)],
    },
  }

  const res = await fetch(AGODA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip,deflate",
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  console.log("✅ Agoda status =", res.status)
  console.log("✅ Agoda raw =", text)

  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    // noop
  }

  if (!res.ok) {
    throw new Error(`Agoda API failed: ${res.status} ${text}`)
  }

  return data
}

/**
 * ✅ 날짜 포함 affiliate 링크
 */
function buildAffiliateLink(params: {
  cid: string
  hotelId: string
  checkInDate?: string
  checkOutDate?: string
  adults?: number
  rooms?: number
}) {
  const { cid, hotelId } = params
  const adults = params.adults ?? 2
  const rooms = params.rooms ?? 1

  const defaults = getDefaultDates()
  const checkIn = params.checkInDate || defaults.checkInDate
  const checkOut = params.checkOutDate || defaults.checkOutDate

  const u = new URL("https://www.agoda.com/partners/partnersearch.aspx")
  u.searchParams.set("hid", hotelId)
  u.searchParams.set("cid", cid)
  u.searchParams.set("checkIn", checkIn)
  u.searchParams.set("checkOut", checkOut)
  u.searchParams.set("rooms", String(rooms))
  u.searchParams.set("adults", String(adults))
  return u.toString()
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function clampStr(s: string, max = 155) {
  const t = (s || "").trim()
  return t.length <= max ? t : t.slice(0, max - 1).trim()
}

/**
 * ✅ 영문 슬러그 생성(없으면 hotelId 기반)
 */
function slugify(input: string) {
  const s = (input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // 악센트 제거
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return s
}

function buildTitle(keyword: string, hotelName: string, version: Version) {
  const regionHints = ["여행", "숙소", "예약", "가이드", "추천", "정리"]
  const tail = pick(regionHints)

  const patterns = [
    `${hotelName} | ${keyword} 예약 전 꼭 볼 정보`,
    `${keyword} 숙소로 ${hotelName} 어때? 핵심만 ${tail}`,
    `${hotelName} 가격·후기·체크포인트 – ${keyword} 기준`,
    `${keyword} 추천: ${hotelName} 장단점 ${tail}`,
    `${hotelName} 한눈에 보기 | ${keyword} 이용 팁`,
  ]

  // version은 "패턴 그룹 선택" 정도로만 사용(너무 고정되면 저품질 느낌)
  if (version === "V1") return patterns[0]
  if (version === "V2") return patterns[1]
  if (version === "V3") return patterns[2]
  return pick(patterns)
}

function buildHashtags(params: { keyword: string; hotelName: string; cityName?: string; countryName?: string }) {
  const { keyword, hotelName, cityName, countryName } = params
  const base = new Set<string>()

  const kw = keyword.split(/\s+/).filter(Boolean).slice(0, 2)
  kw.forEach((k) => base.add(`#${k.replace(/[^가-힣a-zA-Z0-9]/g, "")}`))

  if (cityName) base.add(`#${cityName.replace(/\s+/g, "")}호텔`)
  if (countryName) base.add(`#${countryName.replace(/\s+/g, "")}여행`)

  const hotelTag = hotelName
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, "")
    .split(/\s+/)
    .slice(0, 2)
    .join("")
  if (hotelTag) base.add(`#${hotelTag}`)

  const extras = ["#호텔추천", "#숙소추천", "#가족여행", "#커플여행", "#가성비숙소", "#리조트추천"]
  while (base.size < 5) base.add(pick(extras))
  return Array.from(base).slice(0, 6).join(" ")
}

/**
 * ✅ 템플릿 D: 기본정보박스 + CTA 3개 + 랜덤 문장 + FAQ 스키마
 * + 2000자 미만이면 자동 확장
 */
function buildHtml(params: {
  hotelName: string
  imageURL?: string
  reviewScore?: number
  affiliateUrl: string
  keyword: string
  cityName?: string
  countryName?: string
  checkInDate?: string
  checkOutDate?: string
}) {
  const { hotelName, imageURL, reviewScore, affiliateUrl, keyword, cityName, countryName, checkInDate, checkOutDate } =
    params

  const scoreText = typeof reviewScore === "number" ? `${reviewScore} / 10` : "예약 페이지에서 확인"
  const scheduleText =
    checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 확인"

  const introVariants = [
    `${hotelName}을(를) “${keyword}”로 찾는 분들이 가장 많이 궁금해하는 포인트만 모아서 정리했어요.`,
    `여행 동선을 기준으로 보면 ${hotelName}이(가) 잘 맞는지 빠르게 판단할 수 있게 구성했어요.`,
    `가격/후기/체크포인트를 중심으로 ${hotelName}을(를) 한 번에 훑어볼 수 있게 정리했어요.`,
    `시간 아끼려고 핵심만 담았어요. ${hotelName} 예약 전에 아래 체크리스트만 확인해도 충분해요.`,
  ]

  const oneLineVariants = [
    "한 줄로 보면, 일정과 예산만 맞으면 충분히 만족할 가능성이 높아요.",
    "동선이 편하면 체감 만족도가 크게 올라가요. 위치/교통부터 먼저 체크해보세요.",
    "부대시설(수영장/조식/라운지 등)을 중시한다면 후보로 올려둘 만해요.",
    "성수기에는 변동이 크니, 날짜를 1~2일 바꿔 비교하면 유리할 때가 많아요.",
  ]

  const checklistPool = [
    "무료 취소 마감일/환불 규정을 먼저 확인하세요.",
    "방 타입(전망/침대 구성)과 인원 정책을 확인하세요.",
    "조식 포함/불포함 가격 차이를 비교해보세요.",
    "공항/역 이동 시간과 교통편을 먼저 체크해두면 편해요.",
    "성수기에는 가격 변동이 크니 2~3일 간격으로 비교해보세요.",
    "체크인/체크아웃 시간과 짐 보관 가능 여부를 확인해두면 좋아요.",
    "리조트형이면 수영장/부대시설 운영시간(시즌)을 확인하세요.",
  ]

  const tagsVariants = [
    "#가성비 우선 #리조트/수영장 중심 #가족 여행",
    "#위치 우선 #도보 이동 #첫 방문",
    "#휴양 중심 #커플 여행 #조용한 숙소",
    "#장기 숙박 #편의시설 #실속형",
  ]

  const faqQuestions = [
    { q: `${hotelName} 조식은 어떤가요?`, a: "조식 구성은 시즌/프로모션에 따라 달라질 수 있어요. 포함 여부와 최근 리뷰를 함께 확인해보세요." },
    { q: `${hotelName} 수영장/부대시설은 어떤가요?`, a: "부대시설은 숙소 선택의 핵심 포인트예요. 운영시간/휴무는 시즌에 따라 달라질 수 있어 예약 페이지에서 확인해 주세요." },
    { q: `${hotelName} 체크인/체크아웃 팁이 있나요?`, a: "체크인/체크아웃은 정책에 따라 달라질 수 있어요. 늦은 체크인/레이트 체크아웃 가능 여부를 미리 확인해두면 좋아요." },
    { q: `${hotelName} 주변에 뭐가 있나요?`, a: "주변 환경은 여행 목적(휴양/관광)에 따라 장단점이 달라요. 지도/이동 시간을 기준으로 판단해보세요." },
  ]

  const selectedFaq = [pick(faqQuestions), pick(faqQuestions)].filter((v, i, arr) => arr.findIndex(x => x.q === v.q) === i).slice(0, 2)

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: selectedFaq.map((x) => ({
      "@type": "Question",
      name: x.q,
      acceptedAnswer: { "@type": "Answer", text: x.a },
    })),
  }

  const imgAltVariants = [
    `${hotelName} 객실 전경`,
    `${hotelName} 호텔 전경`,
    `${cityName ? `${cityName} ` : ""}${hotelName} 대표 이미지`,
    `${hotelName} 숙소 사진`,
  ]

  const imgBlock = imageURL
    ? `<div style="text-align:center;margin:18px 0;">
         <img src="${imageURL}" alt="${pick(imgAltVariants)}"
              style="max-width:100%;border-radius:14px;" />
       </div>`
    : ""

  const regionLine =
    cityName || countryName
      ? `<div style="margin:6px 0 0;color:#6b7280;font-size:13px;">📍 지역: ${[cityName, countryName].filter(Boolean).join(", ")}</div>`
      : ""

  const hashtags = buildHashtags({ keyword, hotelName, cityName, countryName })

  const cta1 = `👉 아고다 최저가 확인하기`
  const cta2 = `👉 현재 날짜로 가격/객실 확인`
  const cta3 = `👉 예약 페이지로 이동`

  const listItems = Array.from({ length: 3 }, () => pick(checklistPool))
  const uniqueItems = listItems.filter((v, i, arr) => arr.indexOf(v) === i)

  const basicBox = `
    <div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
      <div style="font-weight:800;font-size:16px;margin-bottom:10px;">🏨 호텔 기본 정보</div>
      ${regionLine}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.5;margin-top:10px;">
        <div><b>호텔명</b><br/>${hotelName}</div>
        <div><b>키워드</b><br/>${keyword}</div>
        <div><b>위치</b><br/>예약 페이지에서 확인</div>
        <div><b>평점</b><br/>${scoreText}</div>
        <div><b>추천 일정</b><br/>${scheduleText}</div>
        <div><b>추천 태그</b><br/>${pick(tagsVariants)}</div>
      </div>
      <div style="margin-top:10px;color:#374151;font-size:13px;">
        ${typeof reviewScore === "number" && reviewScore >= 8.5 ? "평점이 높은 편(8.5점+)이라 안정적인 선택지예요." : "조건(날짜/요금/방 타입)에 따라 체감 만족도가 크게 달라질 수 있어요."}
      </div>
    </div>
  `.trim()

  const btn = (label: string) => `
    <div style="margin:18px 0;text-align:center;">
      <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
         style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block;">
        ${label}
      </a>
    </div>
  `.trim()

  let html = `
${imgBlock}

<h2>${keyword} 추천 호텔: ${hotelName}</h2>
<p>${pick(introVariants)}</p>

${btn(cta1)}

${basicBox}

<h3>핵심 요약</h3>
<p>${pick(oneLineVariants)}</p>

<h3>예약 전 체크리스트</h3>
<ul style="margin:10px 0 0 18px;">
  ${uniqueItems.map((t) => `<li style="margin:6px 0;">${t}</li>`).join("")}
</ul>

${btn(cta2)}

<h3>자주 묻는 질문(FAQ)</h3>
<ul style="margin:10px 0 0 18px;">
  ${selectedFaq.map((x) => `<li style="margin:6px 0;">${x.q}</li>`).join("")}
</ul>

${btn(cta3)}

<h3>해시태그</h3>
<p>${hashtags}</p>

<script type="application/ld+json">
${JSON.stringify(faqJsonLd, null, 2)}
</script>
  `.trim()

  // ✅ 2000자 미만이면 확장(얇은 글 방지)
  html = ensureMinLength(html, 2200, { hotelName, keyword, cityName, countryName })

  return html
}

function ensureMinLength(html: string, minChars: number, ctx: { hotelName: string; keyword: string; cityName?: string; countryName?: string }) {
  if ((html || "").length >= minChars) return html

  const { hotelName, keyword, cityName, countryName } = ctx
  const extraBlocks = [
    `<h3>이 숙소가 잘 맞는 여행 스타일</h3>
<p>${hotelName}은(는) <b>휴양</b> 중심인지, <b>관광</b> 중심인지에 따라 체감이 달라요. ${
      cityName ? `${cityName} 일정에서 이동 시간이 길어지지 않는지` : "이동 시간이 무리 없는지"
    } 먼저 확인해보면 실패 확률이 확 줄어요.</p>`,

    `<h3>가격 비교 팁</h3>
<p>같은 ${keyword}라도 날짜를 1~2일만 바꿔도 요금 차이가 생길 때가 많아요. 주말/연휴/성수기에는 특히 변동폭이 커서, 가능한 경우 <b>여러 날짜로 비교</b>해보는 게 좋아요.</p>`,

    `<h3>체크인 전 마지막 확인</h3>
<p>예약 직전에는 “취소 규정”, “포함 사항(조식/세금)”, “침대 구성” 3가지만 다시 확인해도 실수 확률이 크게 줄어요. 필요한 경우 호텔 측 메시지로 요청사항을 남겨두는 것도 도움이 돼요.</p>`,

    `<h3>${countryName ? `${countryName} 여행` : "여행"}에서 자주 놓치는 포인트</h3>
<p>리조트/호텔은 “좋아 보이는 사진”보다 <b>동선</b>과 <b>실제 이용시간</b>이 만족도를 좌우해요. 공항/역 이동, 주요 스팟 접근성, 밤 이동 안전 등을 함께 고려해보세요.</p>`,
  ]

  let out = html
  let i = 0
  while (out.length < minChars && i < extraBlocks.length * 3) {
    out += `\n\n${pick(extraBlocks)}`
    i++
  }
  return out
}

/**
 * ✅ WP 글 생성 (+ slug + Rank Math meta)
 */
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

  const auth = base64(`${WP_USERNAME}:${WP_APP_PASSWORD}`)

  const body: any = {
    title: params.title,
    content: params.content,
    status: params.status,
    categories: [Number(params.category)],
  }

  // ✅ slug
  if (params.slug) body.slug = params.slug

  // ✅ excerpt를 seoDescription으로 (없으면 생략)
  if (params.seoDescription) body.excerpt = params.seoDescription

  // ✅ Rank Math meta (WPCode에서 show_in_rest 열어둔 상태여야 저장됨)
  body.meta = {
    ...(params.seoTitle ? { rank_math_title: params.seoTitle } : {}),
    ...(params.seoDescription ? { rank_math_description: params.seoDescription } : {}),
    ...(params.focusKeyword ? { rank_math_focus_keyword: params.focusKeyword } : {}),
    ...(params.canonicalUrl ? { rank_math_canonical_url: params.canonicalUrl } : {}),
  }

  // future 발행이면 날짜 필요
  if (params.status === "future") {
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

  if (!res.ok) {
    throw new Error(`WP API failed: ${res.status} ${text}`)
  }

  return data
}

/**
 * ✅ 메인 엔드포인트
 * POST /api/wp/post
 */
export async function POST(req: Request) {
  try {
    // 0) x-api-key 체크
    const API_KEY = process.env.API_KEY
    if (!API_KEY) return jsonError(500, "Missing env: API_KEY")

    const userKey = req.headers.get("x-api-key")
    if (!userKey || userKey !== API_KEY) {
      return jsonError(401, "Unauthorized: invalid x-api-key")
    }

    // 1) 입력 파싱
    const body = await req.json().catch(() => ({}))

    const keywordRaw = safeStr(body.keyword)
    const inputHotelId = safeStr(body.hotelId)
    const hotelUrl = safeStr(body.hotelUrl)
    const version = normalizeVersion(body.version)
    const publishType = normalizePublishType(body.publishType)
    const category = Number(body.category ?? 1)

    const checkInDate = safeStr(body.checkInDate) || undefined
    const checkOutDate = safeStr(body.checkOutDate) || undefined

    // ✅ SEO/slug 입력
    const slug = safeStr(body.slug) || undefined
    const seoTitle = safeStr(body.seoTitle) || undefined
    const seoDescription = safeStr(body.seoDescription) || undefined
    const focusKeyword = safeStr(body.focusKeyword) || undefined
    const canonicalUrl = safeStr(body.canonicalUrl) || undefined

    if (!Number.isFinite(category) || category <= 0) return jsonError(400, "Invalid category")

    // 2) Agoda 인증값 확보 (cid/siteId)
    const { siteId } = getAgodaAuthFromEnv()
    const cid = process.env.AGODA_CID ? String(process.env.AGODA_CID) : siteId

    // 3) hotelId 결정 우선순위: hotelUrl > hotelId > keyword(스크래핑)
    let hotelId: string | null = null

    const hidFromUrl = extractHotelIdFromUrl(hotelUrl)
    if (hidFromUrl) hotelId = hidFromUrl
    if (!hotelId && inputHotelId) hotelId = inputHotelId

    // keyword는 없을 수도 있으니, 나중에 hotelName으로 보정
    let keyword = keywordRaw

    if (!hotelId) {
      if (!keyword) {
        return jsonError(400, "Missing required field: keyword (or provide hotelUrl/hotelId)")
      }
      const resolved = await resolveHotelIdFromKeyword(keyword, cid, "ko-kr")
      if (!resolved) {
        return jsonError(
          404,
          "hotelId 자동 찾기 실패 (keyword로 hid를 찾지 못함). partnersearch에서 hid를 확인하거나 keyword를 더 구체적으로 입력해줘.",
          { keyword }
        )
      }
      hotelId = resolved
    }

    // 4) Agoda 상세 조회
    const agodaData = await agodaGetHotelById(hotelId, checkInDate, checkOutDate)

    const first = agodaData?.results?.[0]
    if (!first) {
      return jsonError(502, "Agoda fetch failed: no results", agodaData)
    }

    const hotelName = first.hotelName || first.propertyName || `Hotel ${hotelId}`
    const imageURL = first.imageURL
    const reviewScore = typeof first.reviewScore === "number" ? first.reviewScore : undefined

    // (가능하면) 위치 정보 추출
    const cityName = safeStr(first.cityName) || safeStr(first.city) || undefined
    const countryName = safeStr(first.countryName) || safeStr(first.country) || undefined

    // keyword 보정(없다면)
    if (!keyword) keyword = `${hotelName} 예약`

    // 5) 날짜 포함 제휴 링크 생성
    const affiliateUrl = buildAffiliateLink({
      cid,
      hotelId: String(first.hotelId ?? hotelId),
      checkInDate,
      checkOutDate,
      adults: 2,
      rooms: 1,
    })

    // 6) 제목/본문 생성
    const title = buildTitle(keyword, hotelName, version)

    const content = buildHtml({
      hotelName,
      imageURL,
      reviewScore,
      affiliateUrl,
      keyword,
      cityName,
      countryName,
      checkInDate,
      checkOutDate,
    })

    // 7) slug 자동 생성(없을 때만)
    const autoSlug =
      slug ||
      (() => {
        const base = slugify(`${cityName || ""} ${hotelName} ${keyword}`) || ""
        if (base.length >= 10) return base.slice(0, 70)
        return `hotel-${String(first.hotelId ?? hotelId)}`
      })()

    // 8) Rank Math SEO 자동 값(없을 때만)
    const autoSeoTitle = seoTitle || title
    const autoSeoDesc =
      seoDescription ||
      clampStr(`${keyword}로 ${hotelName}을(를) 찾는 분들을 위한 핵심 정보(평점·일정·체크리스트)를 정리했습니다. 날짜 포함 링크로 가격/객실을 바로 확인해 보세요.`, 155)

    const autoFocus = focusKeyword || keyword

    // canonicalUrl은 선택(없으면 전달 안 함)
    const wp = await wpCreatePost({
      title,
      content,
      status: publishType,
      category,
      publishAt: body.publishAt ? String(body.publishAt) : undefined,

      slug: autoSlug,
      seoTitle: autoSeoTitle,
      seoDescription: autoSeoDesc,
      focusKeyword: autoFocus,
      canonicalUrl: canonicalUrl || undefined,
    })

    return NextResponse.json({
      success: true,
      resolved: {
        keyword,
        hotelId: String(hotelId),
        agodaHotelId: String(first.hotelId ?? hotelId),
        affiliateUrl,
        cityName,
        countryName,
        slug: autoSlug,
        seoTitle: autoSeoTitle,
        seoDescription: autoSeoDesc,
        focusKeyword: autoFocus,
      },
      wp,
    })
  } catch (err: any) {
    const msg = err?.message || String(err)
    return jsonError(502, msg)
  }
}