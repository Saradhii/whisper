// Every tappable surface in the app. A bare <Pressable> renders nothing on
// touch-down, which reads as lag — and on-device inference means some taps are
// genuinely followed by a second or more of work, so the acknowledgement has to
// come from the button itself rather than from the result arriving.
//
// The feedback is a dim on the pressed state, which lands on the responder
// grant (touch-down), not on release. The UI has always reacted before the
// model has.
//
// Why not Android's native ripple, which would be the more idiomatic choice:
// every configuration of `android_ripple` is wrong on the surfaces this app
// actually has. As a background it is painted underneath the view's own
// backgroundColor, so on a row, card or chip it is invisible. As a foreground
// it is visible but Android does not clip a foreground drawable to the
// rounded outline, so it squares off the corners of every rounded row. Adding
// `overflow: 'hidden'` to clip it removes the drawable instead of trimming it.
// Getting a correct ripple would mean splitting every call site into an outer
// clipping View plus an inner background-less Pressable — a lot of structure
// to buy an effect that opacity already delivers, and delivers on iOS too.
//
// Two modes:
//   opacity (default) — dims while held.
//   none              — no feedback. For long-press-only targets, which sit
//                       inside a scroll view and take a touch on every drag,
//                       so dimming them would flicker the list as you scroll;
//                       and for invisible targets like a dismiss scrim, where
//                       there is nothing to dim.
import { forwardRef } from 'react';
import { Pressable, type PressableProps, type View } from 'react-native';

/** How far a held control dims. Deep enough to read in sunlight, shallow
 *  enough that it doesn't look disabled. */
const PRESSED_OPACITY = 0.6;

const DIMMED = { opacity: PRESSED_OPACITY } as const;

export type Feedback = 'opacity' | 'none';

export type TouchableProps = PressableProps & {
  /** Defaults to 'opacity'. See the mode table above. */
  feedback?: Feedback;
};

export const Touchable = forwardRef<View, TouchableProps>(function Touchable(
  { feedback = 'opacity', style, disabled, ...rest },
  ref,
) {
  // A disabled control must not react, or the feedback promises something the
  // press will not deliver.
  const dims = feedback === 'opacity' && !disabled;

  return (
    <Pressable
      ref={ref}
      disabled={disabled}
      style={
        dims
          ? (state) => [
              typeof style === 'function' ? style(state) : style,
              state.pressed && DIMMED,
            ]
          : style
      }
      {...rest}
    />
  );
});
