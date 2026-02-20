import { NextResponse } from "next/server"

type PublishType = "draft" | "publish" | "future"
type Version = "V1" | "V2" | "V3"

function jsonError(status: number, message: string, detail?: any) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status })
}

function normalizePublishType(v: any): PublishType {
  const s = String(v || "").toLowerCase().trim()
  if (s === "publish") return "publish"
  if (s === "future") return "future"
  return "draft" // ✅ 기본은 무조건 draft
}

function normalizeVersion(v: any): Version {
  const s = String(v || "").toUpperCase().trim()
  if (s === "V2") return "V2"
  if (s === "V3") return "V3"
  return "V1"
}

function base64(s: string) {
  return Buffer.from(s).toString("base64")
}

function extractHidFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const hid = u.searchParams.get("hid")
    return hid ? String(hid).trim() : null
  } catch {
    return null
  }
}

function buildAffiliateUrl(params: {
  hid: string
  cid: string
  hl?: string
  rooms?: number
  adults?: number
  checkInDate?: string
  checkOutDate?: string
}) {
  const u = new URL("https://www.agoda.com/partners/partnersearch.aspx")
  u.searchParams.set("hid", params.hid)
  u.searchParams.set("cid", params.cid)
  u.searchParams.set("hl", params.hl || "ko-kr")
  u.searchParams.set("rooms", String(params.rooms ?? 1))
  u.searchParams.set("adults", String(params.adults ?? 2))
  if (params.checkInDate) u.searchParams.set("checkIn", params.checkInDate)
  if (params.checkOutDate) u.searchParams.set("checkOut", params.checkOutDate)
  return u.toString()
}

function sanitizeHotelName(name: string) {
  return String(name || "")
    .replace(/\s*\|\s*Agoda\.com.*$/i, "")
    .replace(/\s*-\s*Agoda\.com.*$/i, "")
    .trim()
}

async function fetchAgodaMetaByHid(params: { hid: string; cid: string; hl?: string }) {
  // ✅ partnersearch 페이지에서 og:title / og:image / 이미지 여러장(정규식) 추출
  const url = buildAffiliateUrl({
    hid: params.hid,
    cid: params.cid,
    hl: params.hl || "ko-kr",
    rooms: 1,
    adults: 2,
  })

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    },
    cache: "no-store",
  })

  const html = await res.text()

  const ogTitle =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']\s*\/?>/i)?.[1] || ""
  const ogImage =
    html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']\s*\/?>/i)?.[1] || ""

  // ✅ pix*.agoda.net/hotelImages/...jpg 여러 장 수집
  const imgRegex = new RegExp(
    `https:\\/\\/pix\\d+\\.agoda\\.net\\/hotelImages\\/${params.hid}\\/[^"'>\\s]+?\\.jpg\\?[^"'>\\s]*`,
    "gi"
  )
  const found = html.match(imgRegex) || []

  // 중복 제거 + 상위 6장만
  const uniq = Array.from(new Set([ogImage, ...found].filter(Boolean))).slice(0, 6)

  return {
    hotelName: sanitizeHotelName(ogTitle) || `Hotel (hid:${params.hid})`,
    imageURL: uniq[0] || "",
    imageUrls: uniq.length ? uniq : [],
  }
}

function randomPick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function buildTitle(keyword: string, hotelName: string, version: Version) {
  // ✅ 제목 랜덤(패턴 고정 방지)
  const v1 = [
    `${hotelName} | ${keyword} 예약 전 꼭 볼 정보`,
    `${keyword} 고민 끝: ${hotelName} 핵심 정리`,
  ]
  const v2 = [
    `${keyword} 추천: ${hotelName} 가격/후기/예약팁`,
    `${hotelName} 완전정리 | ${keyword} 체크리스트`,
  ]
  const v3 = [
    `${keyword} 완벽 가이드: ${hotelName} (객실·조식·수영장·팁)`,
    `${hotelName} 솔직 분석 | ${keyword} 3분 핵심 요약 + 예약팁`,
  ]

  if (version === "V1") return randomPick(v1)
  if (version === "V2") return randomPick(v2)
  return randomPick(v3)
}

function buildHtmlV1(params: {
  hotelName: string
  keyword: string
  affiliateUrl: string
  imageURL?: string
  checkInDate?: string
  checkOutDate?: string
}) {
  const { hotelName, keyword, affiliateUrl, imageURL, checkInDate, checkOutDate } = params
  return `
<div style="text-align:center;margin:18px 0;">
  ${imageURL ? `<img src="${imageURL}" alt="${hotelName} 대표 이미지" style="max-width:100%;border-radius:14px;" />` : ""}
</div>

<h2>${keyword} 추천 호텔: ${hotelName}</h2>
<p>시간 아끼려고 핵심만 담았어요. 예약 전에 아래 체크리스트만 확인해도 충분해요.</p>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>

<h3>예약 전 체크리스트</h3>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:6px 0;">무료취소 마감일(수수료 0원 구간) 확인</li>
  <li style="margin:6px 0;">조식 포함/불포함 총액 비교</li>
  <li style="margin:6px 0;">${checkInDate && checkOutDate ? `추천 일정: ${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 가격 비교"}</li>
</ul>
`
}

function buildHtmlV3(params: {
  hotelName: string
  keyword: string
  affiliateUrl: string
  imageURL?: string
  imageUrls?: string[]
  checkInDate?: string
  checkOutDate?: string
}) {
  const { hotelName, keyword, affiliateUrl, imageURL, imageUrls = [], checkInDate, checkOutDate } = params

  const hero = imageURL || imageUrls[0] || ""
  const img1 = imageUrls[0] || hero
  const img2 = imageUrls[1] || hero
  const img3 = imageUrls[2] || hero

  // ✅ V3는 “장문(2000자+)” 고정
  // 사실/데이터를 임의로 단정하지 않고, 체크리스트/의사결정형 문장으로 길이를 만든다.
  const introVariants = [
    `요즘 ${keyword}로 검색하는 분들은 “가격이 괜찮은데 실제로 만족할까?”가 가장 궁금해요. 이 글은 ${hotelName}을 예약하기 전에 필요한 판단 기준(객실·조식·수영장·동선·추가요금)을 한 번에 정리한 가이드예요.`,
    `${keyword} 후보가 너무 많아서 결정이 어려울 때, 결국 남는 건 “내 일정에 맞는 동선 + 내 예산에 맞는 총액”이에요. ${hotelName}을 그 기준으로 빠르게 점검해볼게요.`,
  ]

  const scheduleLine =
    checkInDate && checkOutDate ? `${checkInDate} ~ ${checkOutDate}` : "원하는 날짜로 확인"

  return `
<h1>${keyword} 숙소 고민 끝, ${hotelName} 핵심 정리</h1>
<p>${randomPick(introVariants)}</p>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#ff5a5f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    👉 아고다 최저가 확인하기
  </a>
</div>

${hero ? `
<div style="text-align:center;margin:18px 0;">
  <img src="${hero}" alt="${hotelName} 호텔 전경 대표 이미지" style="max-width:100%;border-radius:14px;" />
</div>` : ""}

<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#f8fafc;margin:18px 0;">
  <div style="font-weight:900;font-size:16px;margin-bottom:10px;">🏨 기본 정보 한눈에</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.55;">
    <div><b>호텔명</b><br/>${hotelName}</div>
    <div><b>핵심 키워드</b><br/>${keyword}</div>
    <div><b>추천 일정</b><br/>${scheduleLine}</div>
    <div><b>확인 포인트</b><br/>총액(세금/봉사료) + 무료취소</div>
    <div><b>객실 선택</b><br/>전망/침대/인원정책부터 확정</div>
    <div><b>전환 팁</b><br/>1~2일 이동 비교 + 옵션 분리</div>
  </div>
  <div style="margin-top:10px;color:#374151;font-size:13px;">
    “좋다/나쁘다”보다 <b>내 여행 타입에 맞는지</b>가 핵심이에요. 아래 체크리스트대로만 보면 실패 확률이 확 줄어요.
  </div>
</div>

<h2>1) 객실 선택이 만족도를 좌우하는 이유</h2>
<p>같은 호텔이어도 객실 타입에 따라 체감이 완전히 달라요. 특히 리조트/대형 호텔은 동(건물)·층·전망에 따라 소음/동선/뷰가 갈립니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">전망(오션/가든/시티) vs 예산: “뷰값”이 있는지 확인</li>
  <li style="margin:7px 0;">침대 구성(킹/트윈) + 성인/아동 인원 정책 확인</li>
  <li style="margin:7px 0;">욕실(욕조/샤워)·콘센트·에어컨 상태는 후기에서 반복 언급 체크</li>
</ul>

${img1 ? `
<div style="text-align:center;margin:18px 0;">
  <img src="${img1}" alt="${hotelName} 객실/침대 구성 참고 이미지" style="max-width:100%;border-radius:14px;" />
</div>` : ""}

<h2>2) 조식·수영장·부대시설은 “운영 조건”을 보자</h2>
<p>시설이 많아도 운영시간/예약제/유료 여부 때문에 실제 체감이 달라요. 특히 조식은 혼잡 시간대를 피하면 만족도가 크게 올라갑니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">조식 포함/불포함: 1박당 차이보다 “총액 기준” 비교</li>
  <li style="margin:7px 0;">수영장: 키즈존/성인존 분리, 타월 제공, 운영시간 체크</li>
  <li style="margin:7px 0;">셔틀/스파/키즈클럽: 유료/사전예약 여부 확인</li>
</ul>

${img2 ? `
<div style="text-align:center;margin:18px 0;">
  <img src="${img2}" alt="${hotelName} 전경/부대시설 참고 이미지" style="max-width:100%;border-radius:14px;" />
</div>` : ""}

<h2>3) 가격 비교는 이렇게 하면 손해를 줄인다</h2>
<p>성수기에는 하루 차이로 가격이 크게 달라질 수 있어요. 또한 ‘무료취소’ 조건이 총액에 영향을 주기도 합니다.</p>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">체크인 날짜를 1~2일 바꿔가며 총액 비교</li>
  <li style="margin:7px 0;">무료취소 마감일(몇 시까지인지) 확인</li>
  <li style="margin:7px 0;">세금/봉사료 포함 여부를 반드시 총액으로 비교</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#007bff;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    🏨 객실 옵션/총액 비교하기
  </a>
</div>

${img3 ? `
<div style="text-align:center;margin:18px 0;">
  <img src="${img3}" alt="${hotelName} 추가 이미지" style="max-width:100%;border-radius:14px;" />
</div>` : ""}

<h2>4) 이런 여행자에게 특히 잘 맞는다</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">가족 여행: 키즈 동선 + 부대시설 활용도가 높은 경우</li>
  <li style="margin:7px 0;">커플/허니문: 전망/분위기/프라이버시를 중시하는 경우</li>
  <li style="margin:7px 0;">휴양 중심: 숙소에서 대부분 해결하고 싶은 일정</li>
</ul>

<h2>5) 예약 전 체크리스트(최종)</h2>
<ul style="margin:10px 0 0 18px;">
  <li style="margin:7px 0;">무료취소 마감일과 수수료 규정</li>
  <li style="margin:7px 0;">조식 포함 여부 + 총액(세금/봉사료 포함)</li>
  <li style="margin:7px 0;">객실 타입(전망/침대/인원)과 추가요금</li>
  <li style="margin:7px 0;">이동 동선(공항/역/핵심 스팟)과 교통비</li>
</ul>

<div style="margin:18px 0;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="nofollow noopener"
     style="background:#28a745;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:900;display:inline-block;">
    📅 예약 페이지 바로가기
  </a>
</div>

<h2>자주 묻는 질문(FAQ)</h2>
<div style="margin-top:10px;">
  <div style="margin:12px 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
    <div style="font-weight:900;">Q. ${hotelName} 체크인/체크아웃 팁이 있나요?</div>
    <div style="margin-top:8px;color:#374151;line-height:1.7;">A. 정확한 시간은 예약 페이지 정책이 기준이에요. 늦은 체크인이라면 야간 체크인 가능 여부를 먼저 확인해두면 좋아요.</div>
  </div>
  <div style="margin:12px 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
    <div style="font-weight:900;">Q. 조식 포함 옵션이 유리한가요?</div>
    <div style="margin-top:8px;color:#374151;line-height:1.7;">A. 총액 기준으로 비교하는 게 정답이에요. 1박당 조식 차액이 크지 않다면 포함이 편한 경우가 많습니다.</div>
  </div>
  <div style="margin:12px 0;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
    <div style="font-weight:900;">Q. 사진은 많은데 실제 컨디션이 다를 수 있나요?</div>
    <div style="margin-top:8px;color:#374151;line-height:1.7;">A. 가능해요. 그래서 후기에서 반복 언급되는 “침구/냄새/수압/에어컨” 같은 키워드를 체크하는 게 도움이 됩니다.</div>
  </div>
</div>

<h2>해시태그</h2>
<p>#${keyword.replace(/\s+/g, "")} #숙소추천 #리조트 #가족여행 #커플여행</p>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "${hotelName} 체크인/체크아웃 팁이 있나요?",
      "acceptedAnswer": { "@type": "Answer", "text": "정확한 시간은 예약 페이지 정책이 기준이에요. 늦은 체크인이라면 야간 체크인 가능 여부를 먼저 확인해두면 좋아요." }
    },
    {
      "@type": "Question",
      "name": "조식 포함 옵션이 유리한가요?",
      "acceptedAnswer": { "@type": "Answer", "text": "총액 기준으로 비교하는 게 정답이에요. 1박당 조식 차액이 크지 않다면 포함이 편한 경우가 많습니다." }
    },
    {
      "@type": "Question",
      "name": "사진은 많은데 실제 컨디션이 다를 수 있나요?",
      "acceptedAnswer": { "@type": "Answer", "text": "가능해요. 후기에서 반복 언급되는 침구/냄새/수압/에어컨 같은 키워드를 체크하는 게 도움이 됩니다." }
    }
  ]
}
</script>
`
}

function buildHtmlByVersion(params: {
  version: Version
  hotelName: string
  keyword: string
  affiliateUrl: string
  imageURL?: string
  imageUrls?: string[]
  checkInDate?: string
  checkOutDate?: string
}) {
  if (params.version === "V3") return buildHtmlV3(params)
  if (params.version === "V2") return buildHtmlV3({ ...params, version: "V3" }) // ✅ V2는 일단 V3급 장문으로 (원하면 따로 분리 가능)
  return buildHtmlV1(params)
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

  // ✅ status 안정화: publish/future만 허용, 나머지 전부 draft
  const finalStatus: PublishType =
    params.status === "publish" || params.status === "future" ? params.status : "draft"

  const body: any = {
    title: params.title,
    content: params.content,
    status: finalStatus,
    categories: [Number(params.category)],
  }

  if (params.slug) body.slug = params.slug

  // ✅ Rank Math 메타(등록 가능할 때만)
  body.meta = {
    ...(params.seoTitle ? { rank_math_title: params.seoTitle } : {}),
    ...(params.seoDescription ? { rank_math_description: params.seoDescription } : {}),
    ...(params.focusKeyword ? { rank_math_focus_keyword: params.focusKeyword } : {}),
    ...(params.canonicalUrl ? { rank_math_canonical_url: params.canonicalUrl } : {}),
  }

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

export async function POST(req: Request) {
  try {
    const API_KEY = process.env.API_KEY
    if (!API_KEY) return jsonError(500, "Missing env: API_KEY")

    const headerKey = req.headers.get("x-api-key") || ""
    if (headerKey !== API_KEY) return jsonError(401, "Invalid API key")

    const body = await req.json()

    const keyword = String(body.keyword || "").trim()
    if (!keyword) return jsonError(400, "Missing required field: keyword")

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

    // ✅ hid 결정 (hotelUrl 우선)
    let hotelId = ""
    if (hotelUrl) {
      const hid = extractHidFromUrl(hotelUrl)
      if (hid) hotelId = hid
    }
    if (!hotelId && inputHotelId) hotelId = inputHotelId
    if (!hotelId) {
      return jsonError(404, "hotelId를 찾지 못했어요. hotelUrl(파트너 partnersearch hid 포함) 또는 hotelId를 넣어주세요.")
    }

    const cid = String(process.env.AGODA_CID || "1959499")
    const affiliateUrl = buildAffiliateUrl({
      hid: hotelId,
      cid,
      hl: "ko-kr",
      rooms: 1,
      adults: 2,
      checkInDate,
      checkOutDate,
    })

    // ✅ 호텔명/이미지 fallback 확보
    const meta = await fetchAgodaMetaByHid({ hid: hotelId, cid, hl: "ko-kr" })
    const hotelName = meta.hotelName || `Hotel (hid:${hotelId})`
    const imageURL = meta.imageURL || ""
    const imageUrls = meta.imageUrls || []

    // ✅ 제목/본문 생성 (V3 강제 가능)
    const title = buildTitle(keyword, hotelName, version)
    const content = buildHtmlByVersion({
      version,
      hotelName,
      keyword,
      affiliateUrl,
      imageURL,
      imageUrls,
      checkInDate,
      checkOutDate,
    })

    // ✅ WP 발행(기본 draft)
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
    return jsonError(502, err?.message || String(err))
  }
}