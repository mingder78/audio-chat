import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { Libp2pProvider } from './contexts/Libp2pContext';

createRoot(document.getElementById('root')).render(
  <StrictMode>
     <Libp2pProvider>
       <App />
     </Libp2pProvider>
  
  </StrictMode>,
)
