// The composer — the card you type into. It owns the whole bottom surface:
// the attachment pill, the text field, the model/mic chips, the send button,
// and the recording takeover, so app/index.tsx passes state in and gets one
// element back rather than assembling three layout branches inline.
//
// Shape follows the border-beam demo's chat card (sites/beam/src/mocks.tsx
// upstream): a floating rounded card with a pill on top, the field in the
// middle, and a chip cluster plus a circular send button along the bottom.
// What changed on the way in, and why:
//
//   · The demo's card is 348px wide on a desktop page with 24px controls. Every
//     control here is at least 36px, because these are thumb targets on a phone
//     and 24px is below the ~44px Android/iOS guidance for a primary action.
//   · The demo's send button is neutral grey. Ours is primary red the moment
//     there is something to send, per the rule in theme/palette.ts — primary is
//     "things you tap to commit", and Send is the commit. Grey is reserved for
//     when the press would do nothing, where it reads as unavailable rather
//     than as a fourth color.
//   · The demo's two dropdowns ("Agent", "Auto") are mock text. The one real
//     equivalent this app has is the active model, which until now was only
//     reachable through the drawer — so tapping the chip opens the model
//     picker. There is no second dropdown rather than an invented one.
//
// The beam wrapper paints an absolutely-positioned Skia canvas OVER the card
// with pointerEvents="none", so nothing here needs to know about it and no tap
// is intercepted.
import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TextInput, View } from 'react-native';

import { Touchable, useTheme, useThemedStyles, type Colors } from '@/src/theme';
import { BorderBeam } from '@/src/ui/beam';
import Waveform from '@/src/voice/Waveform';
import type { VoiceState } from '@/src/voice/useVoiceInput';

/** Card corner. Passed to the beam too — it cannot read a child's radius the
 *  way the web version reads the DOM, so the two would drift if this were
 *  written twice. */
const CARD_RADIUS = 22;

/** Circular send/confirm button. 36 rather than the demo's 28: this is the
 *  control the whole screen exists to press. */
const SEND_SIZE = 36;

export type ComposerProps = {
  value: string;
  onChangeText: (text: string) => void;

  /** Commit the message. Never called while `busy`. */
  onSend: () => void;
  /** Interrupt generation. Only reachable while `busy`. */
  onStop: () => void;
  /** A turn is in flight — send becomes stop, and input is frozen. */
  busy: boolean;
  /** The model is loaded and can take a turn. */
  ready: boolean;

  /** Active model's display name, for the chip. */
  modelName: string | null;
  onPressModel: () => void;

  /** Attachment. `onPickImage` is null for a model without vision, which
   *  removes the pill rather than showing one that cannot be honored. */
  image: string | null;
  onPickImage: (() => void) | null;
  onRemoveImage: () => void;

  voice: {
    state: VoiceState;
    start: () => void;
    stop: () => void;
    cancel: () => void;
  };

  /** Safe-area bottom inset — the card floats, so it needs the gap itself. */
  bottomInset: number;
};

/** A bottom-row pill: icon, optional label, optional chevron. */
function Chip({
  icon,
  label,
  chevron = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  busy = false,
}: {
  icon?: ComponentProps<typeof Ionicons>['name'];
  label?: string;
  chevron?: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Touchable
      style={[styles.chip, disabled && styles.dimmed]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}>
      {busy ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : icon ? (
        <Ionicons name={icon} size={18} color={colors.icon} />
      ) : null}
      {label ? (
        <Text style={styles.chipText} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      {chevron ? <Ionicons name="chevron-down" size={14} color={colors.icon} /> : null}
    </Touchable>
  );
}

export default function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  busy,
  ready,
  modelName,
  onPressModel,
  image,
  onPickImage,
  onRemoveImage,
  voice,
  bottomInset,
}: ComposerProps) {
  const { colors, scheme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const recording = voice.state.status === 'recording';
  const transcribing = voice.state.status === 'transcribing';
  // Nothing to commit is a different state from "the model is not up yet", but
  // both make the button a no-op, so both render it neutral.
  const canSend = ready && !busy && (value.trim().length > 0 || image !== null);

  return (
    <BorderBeam
      size="md"
      colorVariant="colorful"
      // Explicit, not 'auto': 'auto' reads the OS scheme, which is the wrong
      // answer for a user who pinned light or dark in Settings — the beam would
      // tune itself for a background the app is not drawing. Same reasoning as
      // ChatOrb.
      theme={scheme}
      borderRadius={CARD_RADIUS}
      // Always on, by design decision. If the GPU cost ever needs reclaiming,
      // `active={busy}` is the one-word change: it ties the beam to the model
      // working, and the component already cross-fades on that prop.
      style={[styles.beam, { marginBottom: bottomInset + 8 }]}>
      <View style={styles.card}>
        {recording ? (
          // Recording takes the card over: cancel · live waveform · confirm.
          // The model chip is gone on purpose — switching models mid-utterance
          // is not a thing anyone means to do.
          <>
            <View style={styles.waveWrap}>
              <Waveform active />
            </View>
            <View style={styles.bottomRow}>
              <Chip
                icon="close"
                label="Cancel"
                onPress={voice.cancel}
                accessibilityLabel="Cancel recording"
              />
              <View style={styles.spacer} />
              <Touchable
                style={[styles.send, styles.sendActive]}
                onPress={voice.stop}
                accessibilityRole="button"
                accessibilityLabel="Finish recording and transcribe">
                <Ionicons name="checkmark" size={20} color={colors.onPrimary} />
              </Touchable>
            </View>
          </>
        ) : (
          <>
            {image ? (
              <View style={styles.attachRow}>
                <Image source={{ uri: image }} style={styles.thumb} />
                <Touchable
                  style={styles.thumbRemove}
                  onPress={onRemoveImage}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attached image">
                  <Ionicons name="close" size={13} color={colors.onPrimary} />
                </Touchable>
              </View>
            ) : onPickImage ? (
              // Top pill, as in the reference. Only for a model that can
              // actually look at the picture.
              <Touchable
                style={[styles.pill, (!ready || busy) && styles.dimmed]}
                onPress={onPickImage}
                disabled={!ready || busy}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Attach an image">
                <Ionicons name="add" size={18} color={colors.icon} />
              </Touchable>
            ) : null}

            <TextInput
              style={styles.input}
              value={value}
              onChangeText={onChangeText}
              placeholder={transcribing ? 'Transcribing…' : ready ? 'Ask anything…' : 'Loading…'}
              placeholderTextColor={colors.textFaint}
              editable={ready && !busy}
              multiline
              textAlignVertical="top"
            />

            <View style={styles.bottomRow}>
              {modelName ? (
                <Chip
                  label={modelName}
                  chevron
                  onPress={onPressModel}
                  accessibilityLabel={`Model: ${modelName}. Change model`}
                />
              ) : null}
              <Chip
                icon="mic-outline"
                busy={transcribing}
                onPress={voice.start}
                disabled={!ready || busy || transcribing}
                accessibilityLabel="Voice input"
              />
              <View style={styles.spacer} />
              <Touchable
                style={[styles.send, busy || canSend ? styles.sendActive : styles.sendIdle]}
                onPress={busy ? onStop : onSend}
                disabled={!busy && !canSend}
                accessibilityRole="button"
                accessibilityLabel={busy ? 'Stop generating' : 'Send message'}>
                <Ionicons
                  name={busy ? 'stop' : 'arrow-up'}
                  size={busy ? 16 : 20}
                  color={busy || canSend ? colors.onPrimary : colors.textFaint}
                />
              </Touchable>
            </View>
          </>
        )}
      </View>
    </BorderBeam>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    // The beam draws to the wrapper's edge, so the wrapper carries the margins
    // and the card carries the paint.
    beam: { marginHorizontal: 12 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: CARD_RADIUS,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 8,
      gap: 8,
    },

    pill: {
      alignSelf: 'flex-start',
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceSunken,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },

    attachRow: { alignSelf: 'flex-start' },
    thumb: { width: 56, height: 56, borderRadius: 12 },
    // Sits on the thumbnail's corner rather than beside it as a "Remove" link:
    // inside a card this small, a text link competes with the placeholder.
    thumbRemove: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary,
    },

    input: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 22,
      paddingHorizontal: 6,
      paddingTop: 4,
      // Two blank lines of room before it starts scrolling, so the card has the
      // reference's proportions when empty instead of collapsing to one line.
      minHeight: 48,
      maxHeight: 120,
    },

    waveWrap: { height: 48, justifyContent: 'center' },

    bottomRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    spacer: { flex: 1 },

    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      height: 32,
      maxWidth: 160,
      paddingHorizontal: 10,
      borderRadius: 16,
      backgroundColor: colors.surfaceSunken,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    chipText: { color: colors.textSecondary, fontSize: 13, flexShrink: 1 },

    send: {
      width: SEND_SIZE,
      height: SEND_SIZE,
      borderRadius: SEND_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendActive: { backgroundColor: colors.primary },
    sendIdle: {
      backgroundColor: colors.surfaceSunken,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },

    dimmed: { opacity: 0.4 },
  });
