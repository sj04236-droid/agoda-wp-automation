import { NextRequest, NextResponse } from "next/server"

/**
 * ✅ 보안/환경변수
API_KEY (또는 INTERNAL_API_KEY) : tjsrudtjsskatjswn  요청 헤더 x-api-key 검증 
* - WP_URL : https://hotel.lineuplounge.co.kr 
* - WP_USERNAME : java0078
* - WP_APP_PASSWORD : "WYUe avRT tSyd yjaw 6tfu v4G0"
* - AGODA_AFFILIATE_CID : 아고다 제휴 CID (예: 1959499) // 없으면 기본값 사용(1959499) */

type Version = "V1" | "V2" | "V3"
type PublishType = "draft" | "publish"

function safeStr(v: any) {
  return typeof v === "string" ? v : ""
}

const FALLBACK_IMAGE =
  "https://picsum.photos/seed/hotel-placeholder/1200/800"

async function validateImage(url?: string): Promise<string | null> {
  if (!url) return null
  const u = url.trim()
  if (!u) return null

  try {
    const head = await fetch(u, { method: "HEAD", redirect: "follow" })
    if (head.ok) return u
  } catch {}

  try {
    const get = await fetch(u, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    })
    if (!get.ok) return null

    const ct = get.headers.get("content-type") || ""
    if (ct.includes("image/")) return u
    return u
  } catch {
    return null
  }
}

function json(res: any, status = 200) {
  return NextResponse.json(res, { status })
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401)
}

function badRequest(msg: string) {
  return json({ error: msg }, 400)
}

function getInternalApiKey() {
  return (
    process.env.API_KEY ||
    process.env.INTERNAL_API_KEY ||
    ""
  )
}

async function agodaGetHotelById(hotelId: string) {
  const url =
    "https://affiliateapi7643.agoda.com/affiliateservice/lt_v1"

  const body = {
    criteria: {
      propertyId: Number(hotelId),
      language: "ko-kr",
      currency: "KRW",
    },
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  return await res.json()
}

async function wpCreatePost(params: {
  title: string
  content: string
  status: PublishType
  category?: number
  tags?: number[]
}) {
  const WP_URL = safeStr(process.env.WP_URL)
  const WP_USERNAME = safeStr(process.env.WP_USERNAME)
  const WP_PASSWORD = safeStr(process.env.WP_PASSWORD)

  if (!WP_URL) throw new Error("WP_URL env missing")
  if (!WP_USERNAME) throw new Error("WP_USERNAME env missing")
  if (!WP_PASSWORD) throw new Error("WP_PASSWORD env missing")

  const token = Buffer.from(`${WP_USERNAME}:${WP_PASSWORD}`).toString("base64")

  const postRes = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      content: params.content,
      status: params.status,
      categories: params.category ? [params.category] : undefined,
      tags: params.tags && params.tags.length > 0 ? params.tags : undefined,
    }),
  })

  return await postRes.json()
}

/* ============================= */
/* ✅ POST 함수 (완전 정상 구조) */
/* ============================= */

export async function POST(req: NextRequest) {
  try {
    const headerKey = safeStr(req.headers.get("x-api-key"))
    const internalKey = getInternalApiKey()
    if (!internalKey || headerKey !== internalKey) return unauthorized()

    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("Invalid JSON body")
    }

    const keyword = safeStr(body.keyword)
    const hotelId = safeStr(body.hotelId)
    const version = (safeStr(body.version) as Version) || "V3"
    const publishType =
      (safeStr(body.publishType) as PublishType) || "draft"
    const category =
      typeof body.category === "number" ? body.category : undefined

    if (!keyword) return badRequest("keyword is required")
    if (!hotelId) return badRequest("hotelId is required")

    const agodaData = await agodaGetHotelById(hotelId)

    const first =
      (agodaData?.results?.[0]) ||
      (agodaData?.data?.[0]) ||
      (agodaData?.result?.[0]) ||
      agodaData

    const hotelName =
      first.hotelName ||
      first.propertyName ||
      `Hotel ${hotelId}`

    const reviewScore =
      typeof first.reviewScore === "number"
        ? first.reviewScore
        : undefined

    const rawHero = safeStr(first.imageURL) || ""
    const rawGallery =
      first.imageUrls ||
      first.images ||
      first.hotelImages ||
      []

    const galleryCandidates: string[] = Array.isArray(rawGallery)
      ? rawGallery.map((x: any) => safeStr(x)).filter(Boolean)
      : []

    const heroImage =
      (await validateImage(rawHero)) || FALLBACK_IMAGE

    const validGallery = (
      await Promise.all(
        galleryCandidates.slice(0, 4).map((u) => validateImage(u))
      )
    ).filter(Boolean) as string[]

    const cid =
      safeStr(process.env.AGODA_AFFILIATE_CID) || "1959499"

    const affiliateUrl = `https://www.agoda.com/partners/partnersearch.aspx?hid=${encodeURIComponent(
      hotelId
    )}&cid=${encodeURIComponent(
      cid
    )}&hl=ko-kr&rooms=1&adults=2`

    const html = `
<h1>${keyword} 완벽 가이드: ${hotelName}</h1>
<img src="${heroImage}" style="width:100%;border-radius:14px;" />
`

    const wp = await wpCreatePost({
      title: `${keyword} 완벽 가이드`,
      content: html,
      status: publishType,
      category,
    })

    return json({
      success: true,
      resolved: {
        keyword,
        hotelId,
        version,
        publishType,
        affiliateUrl,
        imageURL: heroImage,
        imageUrls: validGallery,
      },
      wp,
    })
  } catch (e: any) {
    console.error("API ERROR:", e)
    return NextResponse.json(
      { error: e?.message || String(e) },
      { status: 500 }
    )
  }
}