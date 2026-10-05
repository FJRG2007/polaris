export const Paragraph = (props: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => {
  return (
    <p className="polaris-diagram__paragraph" style={props.style}>
      {props.children}
    </p>
  );
};
