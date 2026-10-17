import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps, ComponentRef, ReactNode, Ref } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, useColors } from './theme';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const colors = useColors();
  return <MaterialCommunityIcons name={name} size={size} color={color ?? colors.text} />;
}

/** A full screen with safe-area padding; scrolls unless `fixed`. */
export function Screen({
  children,
  fixed,
  refreshControl,
  contentStyle,
}: {
  children: ReactNode;
  fixed?: boolean;
  refreshControl?: ComponentProps<typeof ScrollView>['refreshControl'];
  contentStyle?: ViewStyle;
}) {
  const colors = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
      {fixed ? (
        <View style={[styles.content, { flex: 1 }, contentStyle]}>{children}</View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

type Variant = 'title' | 'heading' | 'body' | 'label' | 'caption';
const TEXT: Record<Variant, { fontSize: number; fontWeight: '400' | '500' | '600' | '700'; lineHeight: number }> = {
  title: { fontSize: 26, fontWeight: '700', lineHeight: 32 },
  heading: { fontSize: 18, fontWeight: '600', lineHeight: 24 },
  body: { fontSize: 15, fontWeight: '400', lineHeight: 22 },
  label: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  caption: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
};

export function Text({
  variant = 'body',
  dim,
  color,
  align,
  style,
  ...props
}: TextProps & { variant?: Variant; dim?: boolean; color?: string; align?: 'left' | 'center' | 'right' }) {
  const colors = useColors();
  return (
    <RNText
      {...props}
      style={[TEXT[variant], { color: color ?? (dim ? colors.textDim : colors.text), textAlign: align }, style]}
    />
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  size = 'md',
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg';
}) {
  const colors = useColors();
  const inactive = disabled || loading;
  const palette = {
    primary: { bg: colors.primary, pressed: colors.primaryPressed, fg: colors.onPrimary, border: colors.primary },
    secondary: { bg: colors.surface, pressed: colors.surfaceMuted, fg: colors.text, border: colors.border },
    danger: { bg: colors.surface, pressed: colors.dangerSoft, fg: colors.danger, border: colors.border },
    ghost: { bg: 'transparent', pressed: colors.surfaceMuted, fg: colors.primary, border: 'transparent' },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        size === 'lg' && styles.buttonLarge,
        { backgroundColor: pressed ? palette.pressed : palette.bg, borderColor: palette.border, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon && <Icon name={icon} size={size === 'lg' ? 26 : 20} color={palette.fg} />}
          <RNText style={[styles.buttonText, size === 'lg' && { fontSize: 18 }, { color: palette.fg }]}>{title}</RNText>
        </>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string | null; ref?: Ref<ComponentRef<typeof TextInput>> }) {
  const colors = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label">{label}</Text>
      <TextInput
        placeholderTextColor={colors.textDim}
        {...props}
        style={[
          styles.input,
          { backgroundColor: colors.surface, borderColor: error ? colors.danger : colors.border, color: colors.text },
        ]}
      />
      {error ? (
        <Text variant="caption" color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const colors = useColors();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>;
}

export function Banner({
  tone = 'info',
  icon,
  title,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  icon?: IconName;
  title?: string;
  children?: ReactNode;
}) {
  const colors = useColors();
  const fg = { info: colors.info, success: colors.success, warning: colors.warning, danger: colors.danger }[tone];
  const bg = { info: colors.infoSoft, success: colors.successSoft, warning: colors.warningSoft, danger: colors.dangerSoft }[tone];
  const defaultIcon: IconName = { info: 'information-outline', success: 'check-circle-outline', warning: 'alert-outline', danger: 'alert-circle-outline' }[tone] as IconName;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <Icon name={icon ?? defaultIcon} color={fg} size={20} />
      <View style={{ flex: 1, gap: 2 }}>
        {title && (
          <Text variant="label" color={fg}>
            {title}
          </Text>
        )}
        {typeof children === 'string' ? <Text variant="caption">{children}</Text> : children}
      </View>
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <View style={[styles.centered, { backgroundColor: colors.background }]}>{children}</View>;
}

export function Loading({ message }: { message?: string }) {
  const colors = useColors();
  return (
    <Centered>
      <ActivityIndicator size="large" color={colors.primary} />
      {message && (
        <Text dim align="center" style={{ marginTop: space.lg, maxWidth: 280 }}>
          {message}
        </Text>
      )}
    </Centered>
  );
}

/** A thin horizontal bar, e.g. an attendance percentage. */
export function ProgressBar({ value, color }: { value: number; color: string }) {
  const colors = useColors();
  return (
    <View style={[styles.track, { backgroundColor: colors.surfaceMuted }]}>
      <View style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color, height: '100%', borderRadius: radius.pill }} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  buttonLarge: { minHeight: 64, borderRadius: radius.lg },
  buttonText: { fontSize: 16, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16 },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  banner: { flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg },
  track: { height: 8, borderRadius: radius.pill, overflow: 'hidden' },
});
