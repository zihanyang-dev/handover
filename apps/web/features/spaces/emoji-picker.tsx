import { EmojiPicker } from 'frimousse'

/** The one picker used wherever a Space gets its face. Its caller owns placement and closing. */
export function SpaceEmojiPicker({ choose }: { readonly choose: (emoji: string) => void }) {
  return (
    <EmojiPicker.Root
      className="workspace-emoji-picker"
      columns={8}
      locale="en"
      onEmojiSelect={({ emoji }) => {
        choose(emoji)
      }}
    >
      <div className="workspace-emoji-toolbar">
        <EmojiPicker.Search autoFocus placeholder="Search emoji" aria-label="Search emoji" />
        <EmojiPicker.SkinToneSelector aria-label="Change skin tone" />
      </div>
      <EmojiPicker.Viewport>
        <EmojiPicker.Loading>Loading…</EmojiPicker.Loading>
        <EmojiPicker.Empty>No emoji found.</EmojiPicker.Empty>
        <EmojiPicker.List />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  )
}
