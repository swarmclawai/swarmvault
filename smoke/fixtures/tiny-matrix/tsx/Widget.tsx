type Props = {
  name: string;
};

export function WidgetCard({ name }: Props) {
  return <article>{name}</article>;
}
