// @jsx jsx
import * as React from "react"
import { Box, Text, IconButton, Grid, Button, jsx } from "theme-ui"
import { Circle, Save as SaveIcon, RefreshCcw, FilePlus } from "react-feather"
import { useStateDesigner } from "@state-designer/react"
import { editor } from "../states/editor"
import { ui } from "../states/ui"

const Save: React.FC = ({}) => {
  const local = useStateDesigner(editor)

  return (
    <Grid
      gap={0}
      sx={{
        position: "relative",
        gridArea: "tabs",
        p: 0,
        width: "100%",
        gridTemplateColumns: "1fr 1fr",
        borderLeft: "outline",
        borderBottom: "outline",
        borderColor: "border",
      }}
    >
      <Button onClick={() => ui.send("TABBED_TO_STATE")}>State</Button>
      <Button onClick={() => ui.send("TABBED_TO_PRESENTATION")}>
        Presentation
      </Button>
    </Grid>
  )
}
export default Save
