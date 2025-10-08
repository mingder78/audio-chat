import { useState } from 'react'
import { startLibp2pNode } from './services/libp2p-services'
import CreatePeer from './components/CreatePeer'
import Dialer from './components/Dialer'

function App() {


  return (
    <>
      <h1>Libp2p Audio Chat</h1>
      <audio id="remoteAudio" autoplay></audio>
      <div>
        <CreatePeer />
        <Dialer />
      </div>
    </>
  );
}

export default App
