import { useId } from 'react'
import { SettingsHeading } from '../../components/ui/settings-heading.tsx'
import { YourMachines } from '../machines/space-machines.tsx'
import { Credentials } from './credentials.tsx'
import { DisplayName } from './display-name.tsx'
import { SignOut } from './sign-out.tsx'

/** The person-level settings that stay true whichever Space is open. */
export function AccountSettings() {
  const heading = useId()

  return (
    <section aria-labelledby={heading}>
      <SettingsHeading id={heading} title="Account" />
      <DisplayName />
      <Credentials />
      <YourMachines />
      <SignOut />
    </section>
  )
}
