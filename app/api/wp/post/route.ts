import { NextResponse } from "next/server"

/**
 * ✅ 필수 ENV
 * - API_KEY: Vercel API 보호용(x-api-key)
 * - WP_URL, WP_USERNAME, WP_APP_PASSWORD: WordPress REST API 발행용
 * - AGODA_AUTH: "cid:apiKey" 형태 (예: "1959499:8c98....")
 */

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3" | "V4"

function jsonError(status: number, message: string, detail?: any) {
  return NextResponse.json({ error: message, detail }, { status })
}

function toHttps(url?: string) {
  if (!url) return undefined
  return url.replace(/^http:\/\//i, "https://")
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

function normalizePublishType(v: any): PublishType {
  if (v === "publish" || v === "future" || v === "draft") return v
  return "draft"
}

function normalizeVersion(v: any): Version {
  if (v === "V1" || v === "V2" || v === "V3" || v === "V4") return v
  return "V1"
}

function base64(s: string) {
  return Buffer.from(s, "utf8").toString("base64")
}

/**
 * ✅ Agoda 인증: AGODA_AUTH = "cid:apiKey"
 */
function getAgodaAuthFromEnv() {
  const AGODA_AUTH = process.env.AGODA_AUTH
  if (!AGODA_AUTH) throw new Error("Missing env: AGODA_AUTH (format: cid:apiKey)")

  const parts = AGODA_AUTH.split(":")
  if (parts.length < 2) throw new Error("Invalid AGODA_AUTH format. Must be cid:apiKey")

  const cid = parts[0].trim()
  const apiKey = parts.slice(1).join(":").trim()
  if (!cid || !apiKey) throw new Error("Invalid AGODA_AUTH value (empty cid or apiKey)")

  return { cid, apiKey, authHeader: `${cid}:${apiKey}` }
}

/**
 * ✅ hotelUrl(제휴 링크)에서 hid 추출
 */
function extractHidFromHotelUrl(hotelUrl: string) {
  const m = hotelUrl.match(/[\?&]hid=(\d{3,12})/i)
  return m?.[1] || null
}

/**
 * ✅ keyword로 Agoda 웹 검색 페이지를 긁어서 hid(=hotelId) 하나 뽑기 (마지막 수단)
 */
async function resolveHotelIdFromKeyword(keyword: string, cid: string, hl = "ko-kr") {
  const { checkInDate, checkOutDate } = getDefaultDates()

  const candidates = [
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&textToSearch=${encodeURIComponent(
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
    } catch {}
  }
  return null
}

/**
 * ✅ Agoda lt_v1: hotelId 기반 조회
 */
async function agodaGetHotelById(hotelId: string, checkInDate?: string, checkOutDate?: string) {
  const AGODA_URL = "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"
  const { authHeader } = getAgodaAuthFromEnv()

  const dates = getDefaultDates()
  const inDate = checkInDate || dates.checkInDate
  const outDate = checkOutDate || dates.checkOutDate

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
  } catch {}

  if (!res.ok) throw new Error(`Agoda API failed: ${res.status} ${text}`)
  return data
}

/**
 * ✅ 제휴 링크 생성(날짜 포함)
 */
function buildAffiliateLink(params: {
  cid: string
  hotelId: string
  checkInDate?: string
  checkOutDate?: string
  adults?: number
  rooms?: number
  hl?: string
}) {
  const { cid, hotelId } = params
  const hl = params.hl || "ko-kr"
  const adults = params.adults ?? 2
  const rooms = params.rooms ?? 1

  const q: Record<string, string> = {
    hid: String(hotelId),
    cid: String(cid),
    hl,
    rooms: String(rooms),
    adults: String(adults),
  }
  if (params.checkInDate) q.checkIn = params.checkInDate
  if (params.checkOutDate) q.checkOut = params.checkOutDate

  const qs = Object.entries(q)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")

  return `https://www.agoda.com/partners/partnersearch.aspx?${qs}`
}

function buildImageTag(url: string, alt: string) {
  const safe = toHttps(url)!
  return `
<div style="text-align:center;margin:18px 0;">
  <img src="${safe}" alt="${alt}" style="max-width:100%;border-radius:14px;" />
</div>`.trim()
}

/**
 * ✅ 사용자가 content(완성본 HTML)를 보낸 경우:
 * - content에 <img>가 없으면 imageUrls로 대표/섹션/갤러리 자동 삽입
 */
function injectImagesIntoProvidedHtml(params: {
  html: string
  hotelName: string
  keyword: string
  imageUrls: string[]
}) {
  const { html, hotelName, imageUrls } = params
  if (!html) return html
  if (imageUrls.length === 0) return html
  if (/<img\s/i.test(html)) return html

  const top = buildImageTag(imageUrls[0], `${hotelName} 대표 이미지`)
  const roomImg = imageUrls[1] ? buildImageTag(imageUrls[1], `${hotelName} 객실 이미지`) : ""
  const poolImg = imageUrls[2] ? buildImageTag(imageUrls[2], `${hotelName} 수영장/해변 이미지`) : ""
  const foodImg = imageUrls[3] ? buildImageTag(imageUrls[3], `${hotelName} 조식/레스토랑 이미지`) : ""

  let out = `${top}\n\n${html}`

  const insertAfterHeading = (pattern: RegExp, block: string) => {
    if (!block) return
    out = out.replace(pattern, (m0) => `${m0}\n${block}\n`)
  }

  // V3 섹션 번호(2/3/4)로 끼워넣기 시도
  insertAfterHeading(/<h2[^>]*>\s*2[\s\S]*?<\/h2>/i, roomImg)
  insertAfterHeading(/<h2[^>]*>\s*3[\s\S]*?<\/h2>/i, poolImg)
  insertAfterHeading(/<h2[^>]*>\s*4[\s\S]*?<\/h2>/i, foodImg)

  // 남는 이미지는 하단 갤러리
  const rest = imageUrls.slice(1)
  if (rest.length >= 2) {
    const thumbs = rest
      .slice(0, 4)
      .map((u, i) => {
        const alt = `${hotelName} 사진 ${i + 2}`
        const su = toHttps(u)!
        return `<img src="${su}" alt="${alt}" style="width:100%;border-radius:10px;display:block;" />`
      })
      .join("")
    const gallery = `
<h2>📸 사진 더 보기</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0;">
  ${thumbs}
</div>`.trim()
    out = `${out}\n\n${gallery}`
  }

  return out
}

function buildHtml(params: {
  hotelName: string
  imageURL?: string
  imageUrls?: string[]
  reviewScore?: number
  affiliateUrl: string
  keyword: string
  cityName?: string
  countryName?: string
  checkInDate?: string
  checkOutDate?: string
}) {
  const {
    hotelName,
    imageURL,
    imageUrls,
    reviewScore,
    affiliateUrl,
    keyword,
    cityName,
    countryName,
    checkInDate,
    checkOutDate,
  } = params

  const safeScore = typeof reviewScore === "number" ? reviewScore : null

  const imgs = (imageUrls || []).filter(Boolean).map((u) => toHttps(u)!).filter(Boolean)
  if (imgs.length === 0 && imageURL) imgs.push(toHttps(imageURL)!)

  const topImgBlock = imgs[0] ? buildImageTag(imgs[0], `${hotelName} 대표 이미지`) : ""
  const roomImgBlock = imgs[1] ? buildImageTag(imgs[1], `${hotelName} 객실 이미지`) : ""
  const poolImgBlock = imgs[2] ? buildImageTag(imgs[2], `${hotelName} 수영장/해변 이미지`) : ""
  const foodImgBlock = imgs[3] ? buildImageTag(imgs[3], `${hotelName} 조식/레스토랑 이미지`) : ""

  const ctaButton = (label: string) => `
<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block;">
    👉 ${label}
  </a>
</div>`.trim()

  const tagsPool = [
    "#장기 숙박",
    "#편의시설",
    "#실속형",
    "#가족 여행",
    "#커플 여행",
    "#리조트/수영장 중심",
    "#첫 방문",
    "#가성비 우선",
  ]
  const pickTags = () => {
    const shuffled = [...tagsPool].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, 3).join(" ")
  }

  const randomOne = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]
  const summaryPool = [
    "동선이 편하면 체감 만족도가 크게 올라가요. 위치/교통부터 먼저 체크해보세요.",
    "성수기에는 변동이 크니, 날짜를 1~2일 바꿔 비교하면 유리할 때가 많아요.",
    "리뷰 흐름이 안정적이면 실패 확률이 낮아요. 평점과 최근 리뷰를 같이 보세요.",
  ]
  const checklistPool = [
    "취소 규정(무료 취소 마감일) 체크는 필수예요.",
    "방 타입(전망/침대 구성)과 인원 정책을 확인하세요.",
    "조식 포함/불포함 가격 차이를 비교해보세요.",
    "공항/역 이동 시간과 교통편을 먼저 체크해두면 편해요.",
    "성수기에는 가격 변동이 크니 2~3일 간격으로 비교해보세요.",
    "체크인/체크아웃 시간과 짐 보관 가능 여부를 확인해두면 좋아요.",
  ]
  const pickChecklist = () =>
    [...checklistPool]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((t) => `<li style="margin:6px 0;">${t}</li>`)
      .join("")

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `${hotelName} 체크인/체크아웃 팁이 있나요?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: "체크인/체크아웃은 정책에 따라 달라질 수 있어요. 예약 페이지 기준 시간을 확인해 주세요.",
        },
      },
    ],
  }

  const dateLabel =
    checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 확인"

  const locationLabel =
    cityName || countryName ? `${[cityName, countryName].filter(Boolean).join(", ")}` : "예약 페이지에서 확인"

  return `
${topImgBlock}

<h2>${keyword} 추천 호텔: ${hotelName}</h2>
<p>시간 아끼려고 핵심만 담았어요. ${hotelName} 예약 전에 아래 체크리스트만 확인해도 충분해요.</p>

${ctaButton("아고다 최저가 확인하기")}

<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
  <div style="font-weight:800;font-size:16px;margin-bottom:10px;">🏨 호텔 기본 정보</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.5;margin-top:10px;">
    <div><b>호텔명</b><br/>${hotelName}</div>
    <div><b>키워드</b><br/>${keyword}</div>
    <div><b>위치</b><br/>${locationLabel}</div>
    <div><b>평점</b><br/>${safeScore ? `${safeScore} / 10` : "예약 페이지에서 확인"}</div>
    <div><b>추천 일정</b><br/>${dateLabel}</div>
    <div><b>추천 태그</b><br/>${pickTags()}</div>
  </div>

  <div style="margin-top:10px;color:#374151;font-size:13px;">
    ${safeScore && safeScore >= 8.5 ? "평점이 높은 편(8.5점+)이라 안정적인 선택지예요." : "가격/후기 흐름을 같이 보면 실패 확률이 낮아요."}
  </div>
</div>

<h3>핵심 요약</h3>
<p>${randomOne(summaryPool)}</p>

${roomImgBlock ? `<h3>객실 이미지</h3>\n${roomImgBlock}` : ""}

<h3>예약 전 체크리스트</h3>
<ul style="margin:10px 0 0 18px;">
  ${pickChecklist()}
</ul>

${ctaButton("현재 날짜로 가격/객실 확인")}

${poolImgBlock ? `<h3>부대시설/수영장 이미지</h3>\n${poolImgBlock}` : ""}

${foodImgBlock ? `<h3>조식/레스토랑 이미지</h3>\n${foodImgBlock}` : ""}

<h3>자주 묻는 질문(FAQ)</h3>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:6px 0;">${hotelName} 체크인/체크아웃 팁이 있나요?</li>
</ul>

${ctaButton("예약 페이지로 이동")}

<h3>해시태그</h3>
<p>#${keyword.split(/\s+/).join(" #")} #숙소추천 #가성비숙소</p>

<script type="application/ld+json">
${JSON.stringify(faqJsonLd, null, 2)}
</script>
  `.trim()
}

function buildTitle(keyword: string, hotelName: string, version: Version) {
  const pool = [
    `${hotelName} | ${keyword} 예약 전 꼭 볼 정보`,
    `${keyword} 숙소로 ${hotelName} 어때? 핵심만 정리`,
    `${hotelName} 후기 요약 | ${keyword} 예약 팁`,
    `${keyword} 추천: ${hotelName} 체크리스트 정리`,
  ]
  if (version === "V1") return pool[0]
  if (version === "V2") return pool[1]
  if (version === "V3") return pool[Math.floor(Math.random() * pool.length)]
  return pool[2]
}

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

  const finalStatus =
    params.status === "publish" || params.status === "future" ? params.status : "draft"

  const body: any = {
    title: params.title,
    content: params.content,
    status: finalStatus,
    categories: [Number(params.category)],
  }

  if (params.slug) body.slug = params.slug

  // ✅ Rank Math 메타
  body.meta = {
    ...(params.seoTitle ? { rank_math_title: params.seoTitle } : {}),
    ...(params.seoDescription ? { rank_math_description: params.seoDescription } : {}),
    ...(params.focusKeyword ? { rank_math_focus_keyword: params.focusKeyword } : {}),
    ...(params.canonicalUrl ? { rank_math_canonical_url: params.canonicalUrl } : {}),
  }

  if (params.seoDescription) body.excerpt = params.seoDescription

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

/**
 * ✅ 메인 엔드포인트
 */
export async function POST(req: Request) {
  try {
    const API_KEY = process.env.API_KEY
    if (!API_KEY) return jsonError(500, "Missing env: API_KEY")

    const userKey = req.headers.get("x-api-key")
    if (!userKey || userKey !== API_KEY) {
      return jsonError(401, "Unauthorized: invalid x-api-key")
    }

    const body = await req.json().catch(() => ({}))

    const keyword = String(body.keyword || "").trim()
    const inputHotelId = body.hotelId ? String(body.hotelId).trim() : ""
    const hotelUrl = body.hotelUrl ? String(body.hotelUrl).trim() : ""
    const version = normalizeVersion(body.version)
    const publishType = normalizePublishType(body.publishType)
    const category = Number(body.category ?? 1)

    const checkInDate = body.checkInDate ? String(body.checkInDate).trim() : undefined
    const checkOutDate = body.checkOutDate ? String(body.checkOutDate).trim() : undefined

    const slug = body.slug ? String(body.slug).trim() : undefined
    const seoTitle = body.seoTitle ? String(body.seoTitle).trim() : undefined
    const seoDescription = body.seoDescription ? String(body.seoDescription).trim() : undefined
    const focusKeyword = body.focusKeyword ? String(body.focusKeyword).trim() : undefined
    const canonicalUrl = body.canonicalUrl ? String(body.canonicalUrl).trim() : undefined

    const providedContent = body.content ? String(body.content) : ""

    const imageUrls: string[] = Array.isArray(body.imageUrls)
      ? body.imageUrls
          .map((u: any) => (typeof u === "string" ? u.trim() : ""))
          .filter(Boolean)
          .map((u: string) => toHttps(u)!)
          .filter(Boolean)
      : []

    if (!keyword) return jsonError(400, "Missing required field: keyword")
    if (!Number.isFinite(category) || category <= 0) return jsonError(400, "Invalid category")

    const { cid } = getAgodaAuthFromEnv()

    // hotelId 우선순위: hotelId > hotelUrl(hid) > keyword
    let hotelId = inputHotelId
    if (!hotelId && hotelUrl) {
      const hid = extractHidFromHotelUrl(hotelUrl)
      if (hid) hotelId = hid
    }
    if (!hotelId) {
      const resolved = await resolveHotelIdFromKeyword(keyword, cid, "ko-kr")
      if (!resolved) {
        return jsonError(
          404,
          "hotelId 자동 찾기 실패. hotelId 또는 hotelUrl(제휴 hid 포함)을 넣어줘.",
          { keyword }
        )
      }
      hotelId = resolved
    }

    const agodaData = await agodaGetHotelById(hotelId, checkInDate, checkOutDate)

    const first = agodaData?.results?.[0]
    if (!first) return jsonError(502, "Agoda fetch failed: no results", agodaData)

    const hotelName = first.hotelName || first.propertyName || `Hotel ${hotelId}`
    const imageURL = toHttps(first.imageURL)
    const reviewScore = typeof first.reviewScore === "number" ? first.reviewScore : undefined
    const cityName = first.cityName || undefined
    const countryName = first.countryName || undefined

    const affiliateUrl = buildAffiliateLink({
      cid,
      hotelId: String(first.hotelId ?? hotelId),
      checkInDate,
      checkOutDate,
      adults: 2,
      rooms: 1,
      hl: "ko-kr",
    })

    const title = buildTitle(keyword, hotelName, version)

    const finalImageUrls = imageUrls.length > 0 ? imageUrls : imageURL ? [imageURL] : []

    const content =
      providedContent && providedContent.length > 1500
        ? injectImagesIntoProvidedHtml({
            html: providedContent,
            hotelName,
            keyword,
            imageUrls: finalImageUrls,
          })
        : buildHtml({
            hotelName,
            imageURL,
            imageUrls: finalImageUrls,
            reviewScore,
            affiliateUrl,
            keyword,
            cityName,
            countryName,
            checkInDate,
            checkOutDate,
          })

    const wp = await wpCreatePost({
      title,
      content,
      status: publishType,
      category,
      publishAt: body.publishAt ? String(body.publishAt) : undefined,
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
        hotelId: String(hotelId),
        agodaHotelId: String(first.hotelId ?? hotelId),
        affiliateUrl,
        slug,
        seoTitle,
        seoDescription,
        focusKeyword,
        canonicalUrl,
        imageURL,
        imageUrls: finalImageUrls,
      },
      wp,
    })
  } catch (err: any) {
    const msg = err?.message || String(err)
    return jsonError(502, msg)
  }
}