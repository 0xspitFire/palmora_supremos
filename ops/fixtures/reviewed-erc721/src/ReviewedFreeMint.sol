// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// Synthetic local rehearsal only. This template is never a production registry entry.
contract ReviewedFreeMint {
    uint256 public constant cost = 0;
    uint256 public minted;
    uint256 public constant maximum = 1000;
    uint256 public opens;
    uint256 public closes;
    uint256 public constant limit = 10;
    mapping(address => uint256) public numberMinted;
    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    constructor() { opens = block.timestamp - 1; closes = block.timestamp + 1 days; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x80ac58cd || id == 0x01ffc9a7; }
    function ownerOf(uint256 id) public view returns (address) { require(owners[id] != address(0), 'unknown'); return owners[id]; }
    function approve(address to, uint256 id) external { address owner = ownerOf(id); require(msg.sender == owner || isApprovedForAll[owner][msg.sender], 'owner'); getApproved[id] = to; emit Approval(owner, to, id); }
    function setApprovalForAll(address operator, bool approved) external { require(operator != msg.sender, 'self'); isApprovedForAll[msg.sender][operator] = approved; emit ApprovalForAll(msg.sender, operator, approved); }
    function transferFrom(address from, address to, uint256 id) public { require(ownerOf(id) == from && to != address(0), 'recipient'); require(msg.sender == from || msg.sender == getApproved[id] || isApprovedForAll[from][msg.sender], 'owner'); delete getApproved[id]; owners[id] = to; balanceOf[from]--; balanceOf[to]++; emit Transfer(from, to, id); }
    function safeTransferFrom(address from, address to, uint256 id) external { safeTransferFrom(from, to, id, ''); }
    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public { transferFrom(from, to, id); if (to.code.length > 0) { (bool ok, bytes memory result) = to.call(abi.encodeWithSignature('onERC721Received(address,address,uint256,bytes)', msg.sender, from, id, data)); require(ok && abi.decode(result, (bytes4)) == 0x150b7a02, 'receiver'); } }
    function mint(uint256 quantity) external payable {
        require(msg.value == 0 && quantity > 0 && block.timestamp >= opens && block.timestamp < closes, 'free stage');
        require(numberMinted[msg.sender] + quantity <= limit && minted + quantity <= maximum, 'quantity');
        numberMinted[msg.sender] += quantity;
        for (uint256 i; i < quantity; i++) { uint256 id = ++minted; owners[id] = msg.sender; balanceOf[msg.sender]++; emit Transfer(address(0), msg.sender, id); }
    }
}
contract ReviewedFreeMintFactory {
    mapping(address => bool) public isDeployment;
    event Deployed(address deployment);
    function deploy() external returns (address deployment) { deployment = address(new ReviewedFreeMint()); isDeployment[deployment] = true; emit Deployed(deployment); }
}
