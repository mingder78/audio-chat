import { useState } from 'react'
import { startLibp2pNode } from './services/libp2p-services'
import CreatePeer from './components/CreatePeer'

function App() {


  return (
    <>
      <h1>Libp2p Audio Chat</h1>
      <audio id="remoteAudio" autoplay></audio>
      <div>
        <CreatePeer />
      </div>
    </>
  );
}

export default App
