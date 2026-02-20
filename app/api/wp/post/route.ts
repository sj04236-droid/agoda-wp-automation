import { NextResponse } from "next/server"

/**
 * ✅ 필수 ENV
 * - API_KEY: 네 Vercel API 보호용(x-api-key)
 * - WP_URL, WP_USERNAME, WP_APP_PASSWORD: WP 발행용
 * - AGODA_AUTH: "siteId:apiKey" 형태 (예: "1959499:8c98....")
 *
 * (참고) AGODA_SITE_ID / AGODA_API_KEY 를 따로 쓰고 싶으면 AGODA_AUTH 대신 조합해서 만들면 됨.
 */

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3" | "V4"

function jsonError(status: number, message: string, detail?: any) {
  return NextResponse.json({ error: message, detail }, { status })
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

  return {
    checkInDate: toYMD(inDate),
    checkOutDate: toYMD(outDate),
  }
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
 * ✅ Agoda 인증: AGODA_AUTH = "siteId:apiKey"
 */
function getAgodaAuthFromEnv() {
  const AGODA_AUTH = process.env.AGODA_AUTH
  if (!AGODA_AUTH) throw new Error("Missing env: AGODA_AUTH (format: siteId:apiKey)")

  const parts = AGODA_AUTH.split(":")
  if (parts.length < 2) throw new Error("Invalid AGODA_AUTH format. Must be siteId:apiKey")

  const siteId = parts[0].trim()
  const apiKey = parts.slice(1).join(":").trim() // apiKey에 ':'가 들어가도 방어
  if (!siteId || !apiKey) throw new Error("Invalid AGODA_AUTH value (empty siteId or apiKey)")

  return { siteId, apiKey, authHeader: `${siteId}:${apiKey}` }
}

/**
 * ✅ (추가) partnersearch 링크에서 hid 뽑기
 * 예) https://www.agoda.com/partners/partnersearch.aspx?...&hid=625168
 */
function extractHidFromPartnerUrl(url: string) {
  try {
    const u = new URL(url)
    const hid = u.searchParams.get("hid")
    if (hid && /^\d+$/.test(hid)) return hid
  } catch {}
  return null
}

/**
 * ✅ (기존) keyword로 Agoda 웹 검색 페이지를 긁어서 hid(=hotelId) 하나 뽑기
 * 성공 시: hotelId 숫자 반환
 * 실패 시: null
 */
async function resolveHotelIdFromKeyword(keyword: string, cid: string, hl = "ko-kr") {
  const { checkInDate, checkOutDate } = getDefaultDates()

  // 시도할 URL 후보들 (Agoda가 파라미터를 자주 바꿔서 여러 개 시도)
  const candidates = [
    // 1) textToSearch 형태
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&textToSearch=${encodeURIComponent(keyword)}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
    // 2) city 형태(가끔 동작)
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&city=${encodeURIComponent(keyword)}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
    // 3) asq 형태(가끔 동작)
    `https://www.agoda.com/${hl}/search?cid=${encodeURIComponent(cid)}&asq=${encodeURIComponent(keyword)}&checkIn=${checkInDate}&checkOut=${checkOutDate}&rooms=1&adults=2`,
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

      // ✅ 가장 단순: partnersearch 링크가 박혀있는 경우 hid=숫자
      const hidMatch =
        html.match(/[\?&]hid=(\d{3,10})/i) ||
        html.match(/"hotelId"\s*:\s*(\d{3,10})/i) ||
        html.match(/hotelId%22%3A(\d{3,10})/i)

      if (hidMatch?.[1]) return hidMatch[1]
    } catch {
      // 다음 후보로
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

  const dates = getDefaultDates()
  const inDate = checkInDate || dates.checkInDate
  const outDate = checkOutDate || dates.checkOutDate

  const payload = {
    criteria: {
      language: "ko-kr",
      currency: "KRW",
      occupancy: {
        numberOfAdult: 2,
        numberOfChildren: 0,
      },
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

  if (!res.ok) {
    throw new Error(`Agoda API failed: ${res.status} ${text}`)
  }

  return data
}

function buildAffiliateLink(cid: string, hotelId: string) {
  return `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
    hotelId
  )}&cid=${encodeURIComponent(cid)}`
}

function buildHtml(params: {
  hotelName: string
  imageURL?: string
  reviewScore?: number
  affiliateUrl: string
  keyword: string
  // ✅ (추가) 선택값들 — 없으면 표시 안 됨
  cityName?: string
  countryName?: string
  checkInDate?: string
  checkOutDate?: string
}) {
  const {
    hotelName,
    imageURL,
    reviewScore,
    affiliateUrl,
    keyword,
    cityName,
    countryName,
    checkInDate,
    checkOutDate,
  } = params

  // ---------- 유틸: 랜덤 선택 ----------
  const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]
  const uniqPickN = (arr: string[], n: number) => {
    const copy = [...arr]
    const out: string[] = []
    while (copy.length && out.length < n) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
    }
    return out
  }

  // ---------- 평점에 따른 문장 분기 ----------
  const score = typeof reviewScore === "number" ? reviewScore : null
  const scoreLabel =
    score === null ? "평점 정보는 변동될 수 있어요." :
    score >= 9.0 ? "상위권 만족도(9점대)로 평가가 좋은 편이에요." :
    score >= 8.5 ? "평점이 높은 편(8.5점+)이라 안정적인 선택지예요." :
    score >= 8.0 ? "평점 8점대로 무난하게 만족도가 나오는 편이에요." :
    score >= 7.0 ? "평점이 아주 높진 않지만, 가격/조건에 따라 선택할 만해요." :
    "평점이 낮은 편이라, 조건을 꼼꼼히 비교하고 예약하는 게 좋아요."

  // ---------- 반복 방지용 문장 풀 ----------
  const introPool = [
    `오늘은 “${keyword}” 관점에서 ${hotelName}을(를) 빠르게 정리해볼게요.`,
    `“${keyword}”로 찾는다면 ${hotelName}이 후보에 들어올 수 있어요. 핵심만 정리했어요.`,
    `${hotelName}을(를) “${keyword}” 검색 의도로 보는 분들을 위해, 필요한 정보만 추렸어요.`,
  ]

  const summaryPool = [
    "한 줄로 보면, 일정과 예산만 맞으면 충분히 만족할 가능성이 높아요.",
    "결론부터 말하면, 시설/후기 균형이 괜찮아서 1차 후보로 두기 좋아요.",
    "체크 포인트만 맞으면 ‘실망 확률’을 줄일 수 있는 타입의 숙소예요.",
    "동선과 컨디션을 중요하게 보면, 꽤 합리적인 선택이 될 수 있어요.",
  ]

  const checklistPool = [
    "방 타입(전망/침대 구성)부터 먼저 고르는 게 좋아요.",
    "조식 포함/불포함 가격 차이를 비교해보세요.",
    "취소 규정(무료 취소 마감일) 체크는 필수예요.",
    "공항/역 이동 시간과 교통편을 먼저 확인해두면 편해요.",
    "성수기에는 가격 변동이 크니, 며칠 단위로 비교해보세요.",
  ]

  const recommendForPool = [
    "가족 여행",
    "커플 휴양",
    "리조트/수영장 중심",
    "호캉스",
    "조용한 휴식",
    "첫 방문",
    "가성비 우선",
  ]

  // FAQ 질문 풀(랜덤 2개 뽑기)
  const faqQPool = [
    "가족 여행에 적합한가요?",
    "커플 여행에도 괜찮나요?",
    "조식 평가는 어떤 편인가요?",
    "수영장/부대시설은 어떤가요?",
    "교통(공항/역 이동)은 편한가요?",
    "주변에 뭐가 있나요?",
    "룸 컨디션은 어떤 편인가요?",
    "체크인/체크아웃 팁이 있나요?",
  ]

  const chosenFAQ = uniqPickN(faqQPool, 2)

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: chosenFAQ.map((q) => ({
      "@type": "Question",
      name: `${hotelName} ${q}`,
      acceptedAnswer: {
        "@type": "Answer",
        text:
          q.includes("조식") ? "조식은 시즌/구성에 따라 차이가 있어요. 최신 리뷰와 포함 여부를 확인한 뒤 선택하는 걸 추천해요." :
          q.includes("수영장") ? "수영장/부대시설은 숙소 강점인 경우가 많아요. 다만 운영시간/휴무는 시즌에 따라 달라질 수 있어요." :
          q.includes("교통") ? "교통은 일정에 따라 체감이 달라요. 공항/역 기준 이동 시간을 먼저 체크해두면 실패 확률이 줄어요." :
          q.includes("주변") ? "주변 환경은 여행 스타일에 따라 장단점이 있어요. 목적(휴양/관광)에 맞는지 확인해보세요." :
          q.includes("룸") ? "룸 컨디션은 객실 타입/동/층에 따라 차이가 날 수 있어요. 최근 사진과 리뷰를 꼭 확인해보세요." :
          q.includes("체크인") ? "체크인/체크아웃은 호텔 정책에 따라 달라질 수 있어요. 예약 페이지 기준 시간을 확인해 주세요." :
          "여행 목적(휴양/관광/가족/커플)에 따라 만족도가 달라요. 후기에서 비슷한 목적의 리뷰를 먼저 보는 걸 추천해요.",
      },
    })),
  }

  // ---------- 기본 정보 박스(깔끔한 박스 UI) ----------
  const locationLine =
    cityName || countryName ? `${cityName ? cityName : ""}${cityName && countryName ? ", " : ""}${countryName ? countryName : ""}` : "예약 페이지에서 확인"

  const dateLine =
    checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 변경 가능"

  const scoreLine =
    score === null ? "예약 페이지에서 확인" : `${score} / 10`

  const recommendTags = uniqPickN(recommendForPool, 3).map((t) => `#${t}`).join(" ")

  // ---------- 버튼(상/중/하 3회) ----------
  const ctaButton = (label: string) => `
    <div style="margin:18px 0;text-align:center;">
      <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
         style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block;">
        👉 ${label}
      </a>
    </div>
  `.trim()

  const imgBlock = imageURL
    ? `<div style="text-align:center;margin:18px 0;">
         <img src="${imageURL}" alt="${hotelName}"
              style="max-width:100%;border-radius:14px;" />
       </div>`
    : ""

  // ---------- 본문 구성 ----------
  const intro = pick(introPool)
  const summary = pick(summaryPool)
  const checklist = uniqPickN(checklistPool, 3)
    .map((t) => `<li style="margin:6px 0;">${t}</li>`)
    .join("")

  const infoBox = `
    <div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
      <div style="font-weight:800;font-size:16px;margin-bottom:10px;">🏨 호텔 기본 정보</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.5;">
        <div><b>호텔명</b><br/>${hotelName}</div>
        <div><b>키워드</b><br/>${keyword}</div>
        <div><b>위치</b><br/>${locationLine}</div>
        <div><b>평점</b><br/>${scoreLine}</div>
        <div><b>추천 일정</b><br/>${dateLine}</div>
        <div><b>추천 태그</b><br/>${recommendTags}</div>
      </div>
      <div style="margin-top:10px;color:#374151;font-size:13px;">
        ${scoreLabel}
      </div>
    </div>
  `.trim()

  return `
${imgBlock}

<h2>${keyword} 추천 호텔: ${hotelName}</h2>

<p>${intro}</p>

${ctaButton("아고다 최저가 확인하기")}

${infoBox}

<h3>핵심 요약</h3>
<p>${summary}</p>

<h3>예약 전 체크리스트</h3>
<ul style="margin:10px 0 0 18px;">
  ${checklist}
</ul>

${ctaButton("현재 날짜로 가격/객실 확인")}

<h3>자주 묻는 질문(FAQ)</h3>
<ul style="margin:10px 0 0 18px;">
  ${chosenFAQ.map((q) => `<li style="margin:6px 0;">${hotelName} ${q}</li>`).join("")}
</ul>

${ctaButton("예약 페이지로 이동")}

<script type="application/ld+json">
${JSON.stringify(faqJsonLd, null, 2)}
</script>
  `.trim()
}
function buildTitle(keyword: string, hotelName: string, version: Version) {
  if (version === "V1") return `${hotelName} | ${keyword} 예약 가이드`
  if (version === "V2") return `${keyword} 추천: ${hotelName} 가격/후기 총정리`
  if (version === "V3") return `${hotelName} 완벽 정리 | ${keyword} 최저가 팁`
  return `${keyword} 가성비 숙소: ${hotelName} 한눈에 보기`
}

async function wpCreatePost(params: {
  title: string
  content: string
  status: PublishType
  category: number
  publishAt?: string
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

    const keyword = String(body.keyword || "").trim()
    const inputHotelId = body.hotelId ? String(body.hotelId).trim() : ""
    const hotelUrl = body.hotelUrl ? String(body.hotelUrl).trim() : "" // ✅ (추가)
    const version = normalizeVersion(body.version)
    const publishType = normalizePublishType(body.publishType)
    const category = Number(body.category ?? 1)

    const checkInDate = body.checkInDate ? String(body.checkInDate).trim() : undefined
    const checkOutDate = body.checkOutDate ? String(body.checkOutDate).trim() : undefined

    if (!keyword) return jsonError(400, "Missing required field: keyword")
    if (!Number.isFinite(category) || category <= 0) return jsonError(400, "Invalid category")

    // 2) Agoda 인증값 확보 (cid/siteId)
    const { siteId } = getAgodaAuthFromEnv()

    // 3) hotelId 결정
    let hotelId = inputHotelId

    // ✅ (추가) hotelUrl이 있으면, 여기서 hid를 뽑아서 hotelId로 사용
    if (!hotelId && hotelUrl) {
      const extracted = extractHidFromPartnerUrl(hotelUrl)
      if (extracted) hotelId = extracted
    }

    // ✅ hotelId가 없으면 마지막으로 keyword 자동찾기(기존 방식)
    if (!hotelId) {
      const resolved = await resolveHotelIdFromKeyword(keyword, siteId, "ko-kr")
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

    // 5) 제휴 링크 생성
    const affiliateUrl = buildAffiliateLink(siteId, String(first.hotelId ?? hotelId))

    // 6) HTML + 타이틀
    const title = buildTitle(keyword, hotelName, version)
const content = buildHtml({
  hotelName,
  imageURL,
  reviewScore,
  affiliateUrl,
  keyword,
  checkInDate,
  checkOutDate,
})

    // 7) WP 발행
    const wp = await wpCreatePost({
      title,
      content,
      status: publishType,
      category,
      publishAt: body.publishAt ? String(body.publishAt) : undefined,
    })

    return NextResponse.json({
      success: true,
      resolved: {
        keyword,
        hotelId,
        agodaHotelId: String(first.hotelId ?? hotelId),
        affiliateUrl,
      },
      wp,
    })
  } catch (err: any) {
    const msg = err?.message || String(err)
    return jsonError(502, msg)
  }
}