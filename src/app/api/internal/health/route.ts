import { NextResponse } from 'next/server'
import { healthSnapshot } from '@/lib/domain/api'

export const GET = async () => NextResponse.json(await healthSnapshot())
