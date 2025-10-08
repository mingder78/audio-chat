import { useState } from 'react'
import { startLibp2pNode } from './services/libp2p-services'
import StreamPage from './components/StreamPage'
import Dialer from './components/Dialer'

function App() {


  return (
    <>
      <h1>Libp2p Audio Chat</h1>
      <audio id="remoteAudio" autoplay></audio>
      <div>
        <StreamPage />
        <Dialer />
      </div>
    </>
  );
}

export default App
