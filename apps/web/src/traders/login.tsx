/** The traders login. Its own page and its own cookie: signing in here does nothing on the desk. */

import { useState } from 'react'
import { VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Card } from '@astryxdesign/core/Card'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import type { Role } from '../../../traders/src/types.ts'
import { TradersApiError, tapi } from './api.ts'

export function LoginPage(props: {
  onSignedIn: (user: { username: string; role: Role }) => void
}): React.ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (busy || username === '' || password === '') return
    setBusy(true)
    setError(null)
    try {
      props.onSignedIn(await tapi.login(username.trim().toLowerCase(), password))
    } catch (err) {
      setError(err instanceof TradersApiError ? err.message : 'could not reach the traders server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack align="center" padding={6}>
      <Card>
        <VStack gap={4} padding={5}>
          <VStack gap={1}>
            <Heading level={2}>Delta Desk</Heading>
            <Text color="secondary" size="sm">Delta Desk login — separate from the main desk login</Text>
          </VStack>
          {error !== null ? <Banner status="error" title={error} /> : null}
          <TextInput label="Username" value={username} onChange={setUsername} hasAutoFocus onEnter={() => void submit()} />
          <TextInput label="Password" type="password" value={password} onChange={setPassword} onEnter={() => void submit()} />
          <Button
            variant="primary" label="Sign in" isLoading={busy}
            isDisabled={busy || username === '' || password === ''}
            onClick={() => void submit()}
          />
        </VStack>
      </Card>
    </VStack>
  )
}
