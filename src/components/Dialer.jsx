import { useState } from 'react'
import { startLibp2pNode } from '../services/libp2p-services'
import '../App.css'
import { request, gql } from 'graphql-request';

async function getNodes() {
  const endpoint = 'https://node.cyberfly.io/graphql';

  // 定義 GraphQL 查詢
  const query = gql`
    query {
     nodeInfo {
    peerId }
    }
  `;

  try {
    // 發送 GraphQL 請求
    const data = await request(endpoint, query);
console.log(data.nodeInfo.peerId)
    // 回傳 JSON 格式的回應
    return data.nodeInfo.peerId
  } catch (error) {
    // 錯誤處理
    return error
  }
}

function Dialer() {
  // State for form input and the list of items
  const [formData, setFormData] = useState({ name: '' });
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [remotePeer, setRemotePeer] = useState('...')

  // Handle form input changes
  const handleInputChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      // Mock API call - replace with your actual API endpoint
      const response = await getNodes()
      setRemotePeer(response)
     

      // Assuming the API returns the submitted data or a list
      // For this example, we'll mock a list response by adding the submitted data to the state
      setItems([...items, { id: Date.now(), ...formData }]);
      setFormData({ name: '' }); // Reset form
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="App">
       <p>Remote Peer:🍔 {remotePeer}</p>


       <button onClick={handleSubmit}>get the bootstrap node</button>

      {/* Error Message */}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}

export default Dialer;
