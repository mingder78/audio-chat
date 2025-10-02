import { useState } from 'react'
import { startLibp2pNode } from '../services/libp2p-services'
import '../App.css'

function CreatePeer() {
  const [localPeer, setLocalPeer] = useState('');

  const createPeer = async () => {
    const node = await startLibp2pNode()
    // Logic to create a new peer
    const newPeer = node.peerId.toString();
    setLocalPeer(newPeer);
  };

  return (
    <>
      <div>
        <p>Local Peer: {localPeer}</p>
        <button onClick={createPeer}>create a peer</button>
      </div>
    </>
  );
}

export default CreatePeer;
