import React from "react"
import Counter from "./Examples/Counter"
import Switch from "./Examples/Switch"
import NestedStates from "./Examples/NestedStates"
import Delay from "./Examples/Delay"
import Chain from "./Examples/Chain"
import PlayPauseStop from "./Examples/PlayPauseStop"
import DeepLink from "./Examples/DeepLink"
import OnEvent from "./Examples/OnEvent"
import Blended from "./Examples/Blended"
import Login from "./Examples/Login"
import Editor from "./Editor"

export interface Props {}

const App: React.FC<Props> = ({ children }) => {
  return (
    <div>
      <h1>State Designer</h1>
      <hr />
      <Login />
      {/* <Chain />
      <PlayPauseStop /> */}
      {/* <Blended /> */}
      {/* <Counter />
      <Switch />
      <NestedStates />
      <DeepLink />
      <OnEvent /> */}
      {/* <Editor /> */}
    </div>
  )
}

export default App
