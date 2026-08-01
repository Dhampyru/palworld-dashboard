import { NextResponse } from 'next/server'
import { DEMO_MODE } from '@/lib/demo-mode'

export function GET() {
  return NextResponse.json({ enabled: DEMO_MODE })
}
