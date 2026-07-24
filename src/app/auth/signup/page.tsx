'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { GoogleButton } from '@/components/auth/google-button'
import Link from 'next/link'

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/backstory-symbol-white.png" alt="Backstory" className="mx-auto mb-6 h-7" />
          <h1 className="text-2xl font-semibold text-white">Create your account</h1>
          <p className="mt-1 text-white/70">Get started with Backstory.</p>
        </div>

        <Card className="shadow-3">
          <CardHeader>
            <CardTitle>Create account</CardTitle>
            <CardDescription>
              Continue with your People.ai or Backstory company Google account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <GoogleButton label="Sign up with Google" />

            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                Already have an account?{' '}
                <Link href="/auth/login" className="font-medium text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
